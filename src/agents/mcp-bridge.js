import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import chokidar from 'chokidar';

const VAULT_PATH = process.env.VAULT_PATH || '/media/ydn/SYPHER_CORE/SYPHER_VAULT';
const OBSIDIAN_API_KEY = process.env.OBSIDIAN_API_KEY || '';
const BROKER_URL = 'http://127.0.0.1:9800/api/feed';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export class MCPBrainBridge {
  constructor() {
    this.mcpClient = null;
    this.mcpAvailable = false;
    this.watcher = null;
  }

  async init() {
    await this._tryMCPConnect();
    this._initKernelWatcher();
    console.log('[mcp-bridge] SYPHER Brain MCP Bridge initialized');
    console.log(`[mcp-bridge] Vault: ${VAULT_PATH}`);
    console.log(`[mcp-bridge] MCP: ${this.mcpAvailable ? 'connected' : 'direct file mode'}`);
    console.log('[mcp-bridge] Watcher: inotify kernel events (chokidar)');
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
        env: { ...process.env, OBSIDIAN_API_KEY },
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

  _initKernelWatcher() {
    const targetDirs = ['00_Cortex', '10_Active_Builds', '20_Knowledge_Graph', '30_Concepts'];
    const watchPaths = targetDirs.map(d => join(VAULT_PATH, d));

    this.watcher = chokidar.watch(watchPaths, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    this.watcher.on('change', (filePath) => this._onFileEvent(filePath, 'change'));
    this.watcher.on('add', (filePath) => this._onFileEvent(filePath, 'add'));

    this.watcher.on('ready', () => {
      console.log('[mcp-bridge] Kernel watcher ready — monitoring vault directories');
    });

    this.watcher.on('error', (err) => {
      console.error(`[mcp-bridge] Watcher error: ${err.message}`);
    });
  }

  _onFileEvent(filePath, eventType) {
    if (!filePath.endsWith('.md')) return;

    const relative = filePath.slice(VAULT_PATH.length + 1);
    const parts = relative.split('/');
    const dir = parts[0];
    const file = parts[parts.length - 1];

    this._handleMutation({ path: filePath, file, dir, eventType });
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

    await this._postFeed({
      agentId: 'VAULT_OBSERVER',
      targetSector: sector,
      intensity,
      synapticAssociations: links.slice(0, 5).map(link => ({
        sourceNode: noteId,
        targetNode: link,
        weight: 0.7 + Math.random() * 0.3,
      })),
      payloadSummary: `vault:${noteId} (${links.length} links, ${content.length}b)`,
    });

    await this._postFeed({
      agentId: 'VAULT_MUTATOR',
      targetSector: sector,
      intensity: 0.9,
      synapticAssociations: [],
      payloadSummary: `mutation:${noteId} mass=${mass.toFixed(1)}`,
      _mcpMeta: { nodeId: noteId, mass, links },
    });

    console.log(`[mcp-bridge] ${mutation.eventType}: ${noteId} → ${sector} (${links.length} links)`);
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
    if (dir === '20_Knowledge_Graph' || dir === '30_Concepts') return 'CONCEPT_LAYER';
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

if (process.argv[1] && process.argv[1].includes('mcp-bridge')) {
  const bridge = new MCPBrainBridge();
  bridge.init();
}
