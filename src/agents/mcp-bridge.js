/**
 * SYPHER Brain — Vault Bridge
 * Watches the entire SYPHER_VAULT, parses frontmatter + wikilinks, and pushes
 * persistent VAULT_NODE state to the broker. Also emits VAULT_OBSERVER pulses
 * on mutations so sprites/synapse animations fire.
 *
 * Startup: walks every .md once and seeds the broker with current vault state.
 * Runtime: chokidar inotify on add/change/unlink.
 */
import { readFile, readdir, stat } from 'fs/promises';
import { join, basename, relative } from 'path';
import chokidar from 'chokidar';

const VAULT_PATH = process.env.VAULT_PATH || '/media/ydn/SYPHER_CORE/SYPHER_VAULT';
const BROKER_BASE = process.env.BROKER_BASE || 'http://127.0.0.1:9800';
const BROKER_FEED = `${BROKER_BASE}/api/feed`;
const BROKER_VAULT_NODE = `${BROKER_BASE}/api/vault-node`;
const BROKER_VAULT_DELETE = `${BROKER_BASE}/api/vault-delete`;

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const TEMPLATE_LINKS = new Set(['Target Note', 'wikilink', 'wikilinks', 'backlinks']);

// Directories tracked. Root-level .md (CLAUDE, _CLAUDE, CRITICAL_FACTS, index)
// are handled by watching VAULT_PATH directly with depth 0.
const TRACKED_DIRS = [
  '00_Cortex',
  '10_Active_Builds',
  '20_Knowledge_Graph',
  '30_MOCs',
  '40_Entities',
  '50_Raw',
  '60_Decisions',
];

const DIR_TO_SECTOR = {
  '00_Cortex': 'PREFRONTAL',
  '10_Active_Builds': 'CEREBELLUM',
  '20_Knowledge_Graph': 'CONCEPT_LAYER',
  '30_MOCs': 'PARIETAL',
  '40_Entities': 'TEMPORAL',
  '50_Raw': 'OCCIPITAL',
  '60_Decisions': 'HIPPOCAMPUS',
  '_root': 'SENSORY_CORTEX',
};

const TYPE_TO_CATEGORY = {
  'session-log': 'session',
  'tech-spec': 'project',
  'concept': 'concept',
  'entity': 'entity',
  'decision': 'decision',
  'synthesis': 'synthesis',
  'meta': 'decision',
  'index': 'decision',
};

function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return {};
  const yaml = match[1];
  const out = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([a-z_-]+):\s*(.*)$/i);
    if (m) out[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function extractWikilinks(content) {
  const matches = new Set();
  let match;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    const link = match[1].trim();
    if (!TEMPLATE_LINKS.has(link)) matches.add(link);
  }
  return [...matches];
}

function classifyNote({ dir, frontmatter, content, dirInVault }) {
  // Directory wins for the major vault folders — frontmatter `type: tech-spec`
  // is too generic to use as a primary signal.
  if (dirInVault === '00_Cortex') return 'session';
  if (dirInVault === '10_Active_Builds') return 'project';
  if (dirInVault === '20_Knowledge_Graph') return 'concept';
  if (dirInVault === '30_MOCs') return 'decision';
  if (dirInVault === '40_Entities') return 'entity';
  if (dirInVault === '60_Decisions') return 'decision';
  if (dirInVault === '50_Raw') return 'discovery';

  const fmType = (frontmatter.type || '').toLowerCase();
  if (TYPE_TO_CATEGORY[fmType]) return TYPE_TO_CATEGORY[fmType];

  return 'decision'; // root-level meta files (CLAUDE, CRITICAL_FACTS, index)
}

function noteIdFromPath(filePath) {
  const rel = relative(VAULT_PATH, filePath);
  return rel.replace(/\.md$/, '').replace(/[\/\\]/g, ':');
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForBroker(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BROKER_BASE}/api/topology`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

export class VaultBridge {
  constructor() {
    this.watcher = null;
    this.known = new Map(); // noteId -> { mtime }
  }

  async init() {
    console.log('[vault-bridge] SYPHER Vault Bridge starting');
    console.log(`[vault-bridge] Vault: ${VAULT_PATH}`);
    console.log(`[vault-bridge] Broker: ${BROKER_BASE}`);

    const brokerUp = await waitForBroker();
    if (!brokerUp) {
      console.error('[vault-bridge] Broker never came up — continuing anyway');
    } else {
      console.log('[vault-bridge] Broker reachable');
    }

    await this._seedInitialState();
    this._initWatcher();
    console.log('[vault-bridge] Watcher live — inotify on full vault');
  }

  async _seedInitialState() {
    const files = await this._walkVault();
    console.log(`[vault-bridge] Seeding broker with ${files.length} existing notes`);
    for (const filePath of files) {
      await this._handleFile(filePath, 'seed');
    }
    console.log('[vault-bridge] Initial seed complete');
  }

  async _walkVault() {
    const out = [];

    // Root-level .md files
    try {
      const rootEntries = await readdir(VAULT_PATH, { withFileTypes: true });
      for (const e of rootEntries) {
        if (e.isFile() && e.name.endsWith('.md')) {
          out.push(join(VAULT_PATH, e.name));
        }
      }
    } catch {}

    // Tracked subdirectories (recursive)
    for (const dir of TRACKED_DIRS) {
      const dirPath = join(VAULT_PATH, dir);
      try {
        await this._walkDir(dirPath, out);
      } catch {}
    }
    return out;
  }

  async _walkDir(dir, out) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        await this._walkDir(full, out);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }

  _initWatcher() {
    const watchPaths = [
      VAULT_PATH, // root-level .md
      ...TRACKED_DIRS.map(d => join(VAULT_PATH, d)),
    ];

    this.watcher = chokidar.watch(watchPaths, {
      ignored: (path) => {
        const base = basename(path);
        if (base.startsWith('.')) return true;
        // Only descend into tracked subdirs from root
        if (path === VAULT_PATH) return false;
        return false;
      },
      persistent: true,
      ignoreInitial: true, // initial scan handled by _seedInitialState
      depth: undefined,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    this.watcher.on('add', (p) => this._handleFile(p, 'add'));
    this.watcher.on('change', (p) => this._handleFile(p, 'change'));
    this.watcher.on('unlink', (p) => this._handleUnlink(p));
    this.watcher.on('error', (err) => {
      console.error(`[vault-bridge] Watcher error: ${err.message}`);
    });
  }

  async _handleFile(filePath, eventType) {
    if (!filePath.endsWith('.md')) return;

    const rel = relative(VAULT_PATH, filePath);
    const parts = rel.split(/[\/\\]/);
    const dirInVault = parts.length > 1 ? parts[0] : '_root';
    const file = parts[parts.length - 1];
    const noteId = noteIdFromPath(filePath);

    let content = '';
    let mtime = 0;
    try {
      const s = await stat(filePath);
      mtime = s.mtimeMs;
      content = await readFile(filePath, 'utf-8');
    } catch {
      return;
    }

    const frontmatter = parseFrontmatter(content);
    const links = extractWikilinks(content);
    const category = classifyNote({ frontmatter, content, dirInVault });
    const sector = DIR_TO_SECTOR[dirInVault] || 'TEMPORAL';
    const label = frontmatter.title || basename(file, '.md').replace(/_/g, ' ');
    const mass = Math.min(content.length * 0.008, 12.0);
    const updated = frontmatter.updated || frontmatter.created || '';

    const node = {
      id: noteId,
      label,
      category,
      type: frontmatter.type || 'note',
      status: frontmatter.status || 'active',
      dir: dirInVault,
      sector,
      links: links.slice(0, 30),
      mass,
      updated,
      mtime,
      file: rel,
      subtitle: this._extractFirstParagraph(content),
    };

    this.known.set(noteId, { mtime });
    await postJson(BROKER_VAULT_NODE, node);

    // Pulse a transient feed too (sprite/synapse animation)
    if (eventType !== 'seed') {
      const intensity = eventType === 'add' ? 0.95 : Math.min(0.4 + links.length * 0.05, 0.9);
      await postJson(BROKER_FEED, {
        agentId: 'VAULT_OBSERVER',
        targetSector: sector,
        intensity,
        synapticAssociations: links.slice(0, 5).map(l => ({
          sourceNode: noteId,
          targetNode: l,
          weight: 0.7,
        })),
        payloadSummary: `${eventType}:${label} (${links.length} links)`,
      });
      console.log(`[vault-bridge] ${eventType}: ${noteId} → ${sector} (${links.length} links)`);
    }
  }

  async _handleUnlink(filePath) {
    if (!filePath.endsWith('.md')) return;
    const noteId = noteIdFromPath(filePath);
    this.known.delete(noteId);
    await postJson(BROKER_VAULT_DELETE, { id: noteId });
    console.log(`[vault-bridge] delete: ${noteId}`);
  }

  _extractFirstParagraph(content) {
    const stripped = content.replace(FRONTMATTER_RE, '').trim();
    const para = stripped
      .split('\n\n')
      .map(p => p.trim())
      .find(p => p && !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('-'));
    return para ? para.slice(0, 240) : '';
  }
}

if (process.argv[1] && process.argv[1].includes('mcp-bridge')) {
  const bridge = new VaultBridge();
  bridge.init().catch(err => {
    console.error('[vault-bridge] Fatal:', err);
    process.exit(1);
  });
}
