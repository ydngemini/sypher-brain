/**
 * SYPHER Brain — Claude Transcript Watcher
 *
 * Tails every active Claude Code session log under ~/.claude/projects/ and
 * extracts the things hooks can't see — assistant thinking blocks and the
 * full text of responses. Pushes each as a NEURAL_FEED to the broker so
 * the brain renders Claude's inner monologue alongside its tool use.
 *
 * Files are JSONL. We track byte offset per file; on growth, we read and
 * parse only the new tail. New session files are picked up automatically
 * via chokidar's 'add' event.
 */
import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import chokidar from 'chokidar';

const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
const BROKER = process.env.BROKER_HTTP || 'http://127.0.0.1:9800';

// byte offset cursor per file
const offsets = new Map();

function shorten(s, n = 100) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function postFeed(feed) {
  try {
    await fetch(`${BROKER}/api/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feed),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

function emitFromEntry(entry, filePath) {
  // Entry types: 'user' | 'assistant' | 'queue-operation' | etc.
  if (entry.type !== 'assistant' && entry.type !== 'user') return;
  const msg = entry.message;
  if (!msg) return;
  const role = msg.role;
  const content = msg.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    if (role === 'assistant' && block.type === 'thinking') {
      const txt = shorten(block.thinking || block.text, 120);
      if (!txt) continue;
      postFeed({
        agentId: 'CLAUDE_THINK',
        targetSector: 'HIPPOCAMPUS',
        intensity: 0.75,
        payloadSummary: txt,
        synapticAssociations: [],
      });
    } else if (role === 'assistant' && block.type === 'text') {
      const txt = shorten(block.text, 110);
      if (!txt) continue;
      postFeed({
        agentId: 'CLAUDE_VOICE',
        targetSector: 'PREFRONTAL',
        intensity: 0.7,
        payloadSummary: txt,
        synapticAssociations: [],
      });
    } else if (role === 'assistant' && block.type === 'tool_use') {
      // Hooks already cover tool_use, so don't double-emit
    } else if (role === 'user' && block.type === 'tool_result') {
      const txt = block.content
        ? shorten(typeof block.content === 'string' ? block.content : JSON.stringify(block.content), 90)
        : '';
      if (!txt) continue;
      postFeed({
        agentId: 'TOOL_FEEDBACK',
        targetSector: 'OCCIPITAL',
        intensity: 0.45,
        payloadSummary: txt,
        synapticAssociations: [],
      });
    }
  }
}

async function readNewLines(filePath) {
  let s;
  try { s = await stat(filePath); } catch { return; }
  const lastOffset = offsets.get(filePath) || 0;
  if (s.size <= lastOffset) return;

  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return;
  }
  // Read from lastOffset onward (UTF-8 boundary safety: we read the full file
  // and slice — JSONL log entries are typically <16KB so cost is minimal)
  const tail = content.slice(lastOffset);
  offsets.set(filePath, content.length);

  const lines = tail.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      emitFromEntry(entry, filePath);
    } catch {
      // partial/invalid line — skip; offset advanced past it
    }
  }
}

async function walkJsonlFiles(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await walkJsonlFiles(p, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(p);
    }
  }
  return out;
}

async function seedOffsets() {
  // On startup, set offsets to current file sizes so we don't replay history.
  // New entries written after this point fire 'change' and get parsed live.
  const files = await walkJsonlFiles(PROJECTS_DIR);
  for (const f of files) {
    try {
      const s = await stat(f);
      offsets.set(f, s.size);
    } catch {}
  }
  console.log(`[transcript-watcher] seeded offsets for ${files.length} existing transcript files`);
}

async function main() {
  console.log('[transcript-watcher] SYPHER Transcript Watcher starting');
  console.log(`[transcript-watcher] Projects: ${PROJECTS_DIR}`);
  console.log(`[transcript-watcher] Broker:   ${BROKER}`);

  await seedOffsets();

  const watcher = chokidar.watch(PROJECTS_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 3,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 40 },
  });

  watcher.on('add', (p) => {
    if (!p.endsWith('.jsonl')) return;
    offsets.set(p, 0);   // brand-new file → read from start
    readNewLines(p);
  });
  watcher.on('change', (p) => {
    if (!p.endsWith('.jsonl')) return;
    readNewLines(p);
  });
  watcher.on('ready', () => {
    console.log('[transcript-watcher] inotify ready — tailing all Claude sessions');
  });
  watcher.on('error', (err) => {
    console.error(`[transcript-watcher] watcher error: ${err.message}`);
  });
}

main().catch(err => {
  console.error('[transcript-watcher] fatal:', err);
  process.exit(1);
});
