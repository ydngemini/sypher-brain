import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, readdir, stat } from 'fs/promises';
import { join, basename, extname } from 'path';

const VAULT_PATH = process.env.VAULT_PATH || '/media/ydn/SYPHER_CORE/SYPHER_VAULT';
const OBSIDIAN_API = `http://${process.env.OBSIDIAN_HOST || '127.0.0.1'}:${process.env.OBSIDIAN_PORT || '27124'}`;
const OBSIDIAN_API_KEY = process.env.OBSIDIAN_API_KEY || '';
const BROKER_URL = 'http://127.0.0.1:9800/api/feed';
const POLL_INTERVAL = 4000;

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export class MCPBrainBridge {
  constructor() {
    this.mcpClient = null;
    this.mcpAvailable = false;
    this.knownFiles = new Map();
    this.lastScan = 0;
  }

  async init() {
    await this._tryMCPConnect();
    this._startPolling();
    console.log('[mcp-bridge] SYPHER Brain MCP Bridge initialized');
    console.log(`[mcp-bridge] Vault: ${VAULT_PATH}`);
    console.log(`[mcp-bridge] MCP: ${this.mcpAvailable ? 'connected' : 'direct file mode'}`);
  }

  async _tryMCPConnect() {
    if (!OBSIDIAN_API_KEY) {
      this.mcpAvailable = false;
      console.log('[mcp-bridge] No OBSIDIAN_API_KEY — using direct vault reads');
      return;
    }

    try {
      const transport = new StdioClientTransport({
        command: 'uvx',
        args: ['mcp-obsidian'],
        env: {
          ...process.env,
          OBSIDIAN_API_KEY,
        },
      });

      this.mcpClient = new Client({ name: 'SypherBrainBridge', version: '4.0.0' });
      await this.mcpClient.connect(transport);
      this.mcpAvailable = true;
      console.log('[mcp-bridge] MCP Obsidian server connected');
    } catch (err) {
      this.mcpAvailable = false;
      console.log(`[mcp-bridge] MCP unavailable (${err.message}) — using direct vault reads`);
    }
  }

  _startPolling() {
    this._scanVault();
    setInterval(() => this._scanVault(), POLL_INTERVAL);
  }

  async _scanVault() {
    try {
      const dirs = ['00_Cortex', '10_Active_Builds', '20_Knowledge_Graph', '30_Concepts'];
      let mutations = [];

      for (const dir of dirs) {
        const dirPath = join(VAULT_PATH, dir);
        try {
          const files = await readdir(dirPath);
          for (const file of files) {
            if (extname(file) !== '.md') continue;
            const fullPath = join(dirPath, file);
            const info = await stat(fullPath);
            const mtimeMs = info.mtimeMs;
            const prevMtime = this.knownFiles.get(fullPath);

            if (!prevMtime) {
              this.knownFiles.set(fullPath, mtimeMs);
            } else if (mtimeMs > prevMtime) {
              this.knownFiles.set(fullPath, mtimeMs);
              mutations.push({ path: fullPath, file, dir, mtime: mtimeMs });
            }
          }
        } catch {}
      }

      for (const mutation of mutations) {
        await this._handleMutation(mutation);
      }
    } catch {}
  }

  async _handleMutation(mutation) {
    const { path, file, dir } = mutation;
    const noteId = basename(file, '.md');

    let content = '';
    if (this.mcpAvailable) {
      try {
        const result = await this.mcpClient.callTool({
          name: 'get_file_contents',
          arguments: { filepath: `${dir}/${file}` },
        });
        const textBlocks = result?.content?.filter(c => c.type === 'text') || [];
        content = textBlocks.map(b => b.text).join('\n') || '';
        if (!content) content = await readFile(path, 'utf-8').catch(() => '');
      } catch {
        content = await readFile(path, 'utf-8').catch(() => '');
      }
    } else {
      content = await readFile(path, 'utf-8').catch(() => '');
    }

    const links = this._extractWikilinks(content);
    const sector = this._classifySector(dir, content);
    const mass = Math.min(content.length * 0.008, 12.0);
    const intensity = Math.min(0.4 + links.length * 0.1, 1.0);

    const feed = {
      agentId: 'VAULT_OBSERVER',
      targetSector: sector,
      intensity,
      synapticAssociations: links.slice(0, 5).map(link => ({
        sourceNode: noteId,
        targetNode: link,
        weight: 0.7 + Math.random() * 0.3,
      })),
      payloadSummary: `vault:${noteId} (${links.length} links, ${content.length}b)`,
    };

    await this._postFeed(feed);

    // Emit specialized MCP_NODE_MUTATION for the instanced engine
    await this._postFeed({
      agentId: 'VAULT_MUTATOR',
      targetSector: sector,
      intensity: 0.9,
      synapticAssociations: [],
      payloadSummary: `mutation:${noteId} mass=${mass.toFixed(1)}`,
      vectorTarget: null,
      _mcpMeta: { nodeId: noteId, mass, links },
    });

    console.log(`[mcp-bridge] Mutation: ${noteId} → ${sector} (${links.length} links)`);
  }

  _extractWikilinks(content) {
    const matches = [];
    let match;
    while ((match = WIKILINK_RE.exec(content)) !== null) {
      matches.push(match[1].trim());
    }
    return [...new Set(matches)];
  }

  _classifySector(dir, content) {
    if (dir === '00_Cortex') return 'PREFRONTAL';
    if (dir === '10_Active_Builds') return 'CEREBELLUM';
    if (dir === '20_Knowledge_Graph') return 'CONCEPT_LAYER';
    if (dir === '30_Concepts') return 'CONCEPT_LAYER';

    if (content.includes('[[Decision') || content.includes('## Decision'))
      return 'PREFRONTAL';
    if (content.includes('[[Architecture') || content.includes('## Stack'))
      return 'CONTEXT_CORTEX';
    if (content.includes('[[Session') || content.includes('## Log'))
      return 'HIPPOCAMPUS';

    return 'TEMPORAL';
  }

  async _postFeed(feed) {
    try {
      const res = await fetch(BROKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feed),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// Standalone execution
if (process.argv[1] && process.argv[1].includes('mcp-bridge')) {
  const bridge = new MCPBrainBridge();
  bridge.init();
}
