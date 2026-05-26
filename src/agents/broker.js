import dgram from 'dgram';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, normalize } from 'path';

const VAULT_PATH = process.env.VAULT_PATH || '/media/ydn/SYPHER_CORE/SYPHER_VAULT';

const HTTP_PORT = 9800;
const UDP_PORT = 3456;
const HEARTBEAT_INTERVAL = 30000;

// Topological Adjacency Matrix — live weight space for neuromorphic routing
const conceptWeights = {
  PREFRONTAL:     { coordinates: [0.0, 0.4, 0.7],   baseColor: [1.0, 0.23, 0.19] },
  CONCEPT_LAYER:  { coordinates: [-0.3, 0.0, 0.2],  baseColor: [1.0, 0.58, 0.0] },
  SENSORY_CORTEX: { coordinates: [0.7, 0.1, 0.1],   baseColor: [0.0, 0.9, 0.95] },
  TEMPORAL:       { coordinates: [-0.7, -0.3, -0.1], baseColor: [1.0, 0.6, 0.1] },
  PARIETAL:       { coordinates: [0.0, 0.6, -0.2],   baseColor: [0.2, 0.8, 0.4] },
  OCCIPITAL:      { coordinates: [0.0, -0.1, -0.7],  baseColor: [0.5, 0.55, 0.97] },
  HIPPOCAMPUS:    { coordinates: [-0.5, -0.5, 0.3],  baseColor: [0.30, 0.85, 0.39] },
  CEREBELLUM:     { coordinates: [-0.8, 0.1, 0.0],   baseColor: [0.9, 0.2, 0.7] },
};

// ─── Command classification via real transformer inference ─────────────────
//
// We embed the command through the bge-small-en ONNX server (already serving
// the visualizer) and cosine-match against a set of sector anchor texts. The
// regex form below is kept only as a cold-start fallback used until the bge
// anchors are loaded (~100ms after broker boot).
//
// Each anchor is a short prose description of what that sector does — bge
// places semantically similar commands near the right anchor in 384-dim space.

const EMBED_URL = process.env.EMBED_URL || 'http://127.0.0.1:5175';

const SECTOR_ANCHORS = [
  { sector: 'HIPPOCAMPUS',    agentName: 'GIT_REPOSITOR',  color: '#f05032',
    text: 'version control history commit clone push branch git repository archive' },
  { sector: 'CONCEPT_LAYER',  agentName: 'RUNTIME_ENGINE', color: '#3776ab',
    text: 'execute run program interpreter language script python node runtime' },
  { sector: 'CEREBELLUM',     agentName: 'ORCHESTRATOR',   color: '#2496ed',
    text: 'orchestrate container deploy systemd service kubernetes docker pods' },
  { sector: 'CEREBELLUM',     agentName: 'BUILD_SYSTEM',   color: '#cb3837',
    text: 'install build package dependency npm cargo make pip compile bundle' },
  { sector: 'PREFRONTAL',     agentName: 'EDITOR_CORTEX',  color: '#007acc',
    text: 'edit author write modify source code editor IDE author intentional decision' },
  { sector: 'TEMPORAL',       agentName: 'SEARCH_MATRIX',  color: '#f59e0b',
    text: 'search find query pattern grep regex match locate over time sequence' },
  { sector: 'SENSORY_CORTEX', agentName: 'NET_CONDUIT',    color: '#22d3ee',
    text: 'network connect fetch download send transmit request http ssh remote' },
  { sector: 'OCCIPITAL',      agentName: 'READ_STREAM',    color: '#818cf8',
    text: 'read view examine inspect file contents stream output cat less head tail' },
  { sector: 'PARIETAL',       agentName: 'FS_NAVIGATOR',   color: '#34d399',
    text: 'navigate move filesystem directory path list cd ls mkdir tree pwd' },
  { sector: 'PREFRONTAL',     agentName: 'SYSTEM_KERNEL',  color: '#00f3ff',
    text: 'system kernel ambient process generic miscellaneous control flow' },
];

let anchorEmbeddings = null;  // [{...anchor, vec: Float32Array}]
const cmdEmbedCache = new Map(); // cmd-string → {vec, classification}
const CMD_CACHE_MAX = 1000;

function dotProduct(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

async function embedTexts(texts) {
  const res = await fetch(`${EMBED_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`embed ${res.status}`);
  const data = await res.json();
  return (data.embeddings || []).map(v => new Float32Array(v));
}

async function loadAnchors() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const texts = SECTOR_ANCHORS.map(a => a.text);
      const vecs = await embedTexts(texts);
      if (vecs.length !== SECTOR_ANCHORS.length) throw new Error('vec count mismatch');
      anchorEmbeddings = SECTOR_ANCHORS.map((a, i) => ({ ...a, vec: vecs[i] }));
      console.log(`[broker] classifier: bge anchors loaded (${anchorEmbeddings.length} sectors)`);
      return;
    } catch (err) {
      if (attempt === 0) console.log(`[broker] classifier: waiting for embed-server (${err.message})`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.error('[broker] classifier: embed-server unreachable — staying on regex fallback');
}

// Regex fallback for cold start and embed-server outages
function dissectCommandRegex(cmd) {
  const root = cmd.split(/\s+/)[0].toLowerCase();
  if (/^(git|gh|hub)$/.test(root))
    return { agentName: 'GIT_REPOSITOR', color: '#f05032', targetSector: 'HIPPOCAMPUS' };
  if (/^(python|python3|node|bun|deno|tsx|ts-node)$/.test(root))
    return { agentName: 'RUNTIME_ENGINE', color: '#3776ab', targetSector: 'CONCEPT_LAYER' };
  if (/^(docker|podman|systemctl|journalctl|kubectl)$/.test(root))
    return { agentName: 'ORCHESTRATOR', color: '#2496ed', targetSector: 'CEREBELLUM' };
  if (/^(npm|pnpm|yarn|pip|cargo|make|cmake)$/.test(root))
    return { agentName: 'BUILD_SYSTEM', color: '#cb3837', targetSector: 'CEREBELLUM' };
  if (/^(vim|nvim|code|nano|emacs|claude)$/.test(root))
    return { agentName: 'EDITOR_CORTEX', color: '#007acc', targetSector: 'PREFRONTAL' };
  if (/^(grep|rg|find|fd|ag|ack|locate)$/.test(root))
    return { agentName: 'SEARCH_MATRIX', color: '#f59e0b', targetSector: 'TEMPORAL' };
  if (/^(curl|wget|ssh|scp|rsync|nc)$/.test(root))
    return { agentName: 'NET_CONDUIT', color: '#22d3ee', targetSector: 'SENSORY_CORTEX' };
  if (/^(cat|less|head|tail|bat|jq|yq)$/.test(root))
    return { agentName: 'READ_STREAM', color: '#818cf8', targetSector: 'OCCIPITAL' };
  if (/^(cd|ls|ll|tree|pwd|mkdir|rm|mv|cp)$/.test(root))
    return { agentName: 'FS_NAVIGATOR', color: '#34d399', targetSector: 'PARIETAL' };
  return { agentName: 'SYSTEM_KERNEL', color: '#00f3ff', targetSector: 'PREFRONTAL' };
}

async function dissectCommandContext(cmd) {
  // Fast paths: cache hit, or anchors not yet loaded
  const cached = cmdEmbedCache.get(cmd);
  if (cached) return cached.classification;
  if (!anchorEmbeddings) return dissectCommandRegex(cmd);

  // Real model inference: embed the command, cosine vs each sector anchor
  try {
    const [vec] = await embedTexts([cmd]);
    if (!vec) return dissectCommandRegex(cmd);

    let bestScore = -Infinity;
    let best = anchorEmbeddings[0];
    for (const a of anchorEmbeddings) {
      const s = dotProduct(vec, a.vec); // bge is L2-normalized → dot == cosine
      if (s > bestScore) { bestScore = s; best = a; }
    }
    const classification = {
      agentName: best.agentName,
      color: best.color,
      targetSector: best.sector,
      _confidence: bestScore,
    };

    cmdEmbedCache.set(cmd, { vec, classification });
    if (cmdEmbedCache.size > CMD_CACHE_MAX) {
      const firstKey = cmdEmbedCache.keys().next().value;
      cmdEmbedCache.delete(firstKey);
    }
    return classification;
  } catch {
    return dissectCommandRegex(cmd);
  }
}

// ------ State ------
const state = {
  agents: new Map(),
  feeds: [],
  clients: new Set(),
  telemetryCount: 0,
  vaultNodes: new Map(),       // noteId -> persistent vault node
  observations: new Map(),     // observation id -> latest observation
  lastObservationId: 0,
};

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of state.clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function handleNeuralFeed(feed) {
  const { agentId, targetSector, intensity, synapticAssociations, payloadSummary } = feed;
  if (!agentId || !targetSector) return;

  const entry = {
    ...feed,
    timestamp: Date.now(),
    id: `feed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    vectorTarget: conceptWeights[targetSector]?.coordinates || [0, 0, 0],
  };

  state.feeds.push(entry);
  if (state.feeds.length > 500) state.feeds.shift();

  const agent = state.agents.get(agentId) || { id: agentId, feeds: 0, lastSector: null, lastActive: 0 };
  agent.feeds++;
  agent.lastSector = targetSector;
  agent.lastActive = Date.now();
  agent.lastSummary = payloadSummary;
  agent.intensity = intensity;
  agent.status = 'active';
  state.agents.set(agentId, agent);

  broadcast({ type: 'NEURAL_FEED', data: entry });
  broadcast({ type: 'AGENT_UPDATE', data: agent });

  console.log(`[broker] FEED ${agentId} → ${targetSector} (${intensity.toFixed(2)}) "${payloadSummary}"`);
}

// ------ Pillar 1: UDP Telemetry Listener ------
const udpServer = dgram.createSocket('udp4');

udpServer.on('message', async (msg) => {
  try {
    const telemetry = JSON.parse(msg.toString());
    if (!telemetry.cmd) return;

    state.telemetryCount++;
    const analysis = await dissectCommandContext(telemetry.cmd);
    const intensity = Math.min(telemetry.cmd.length * 0.02 + 0.1, 1.0);

    const feed = {
      agentId: analysis.agentName,
      targetSector: analysis.targetSector,
      intensity,
      synapticAssociations: [{
        sourceNode: telemetry.pwd.split('/').pop() || 'root',
        targetNode: analysis.agentName,
        weight: telemetry.status === 0 ? 0.8 : 0.3,
      }],
      payloadSummary: telemetry.cmd.slice(0, 80),
    };

    handleNeuralFeed(feed);

    // Also broadcast raw telemetry for the instanced shader system
    broadcast({
      type: 'SYNAPSE_ACTIVATION',
      meta: {
        command: telemetry.cmd,
        directory: telemetry.pwd,
        success: telemetry.status === 0,
      },
      agent: {
        identifier: analysis.agentName,
        hexColor: analysis.color,
        targetSector: analysis.targetSector,
        vectorTarget: conceptWeights[analysis.targetSector].coordinates,
      },
      dynamics: {
        intensity,
        timestamp: telemetry.time,
      },
    });
  } catch {}
});

udpServer.on('listening', () => {
  console.log(`[broker] UDP telemetry listener on 127.0.0.1:${UDP_PORT}`);
});

udpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[broker] UDP port ${UDP_PORT} in use — retrying in 2s...`);
    setTimeout(() => udpServer.bind(UDP_PORT, '127.0.0.1'), 2000);
  } else {
    console.error(`[broker] UDP error: ${err.message}`);
  }
});

udpServer.bind(UDP_PORT, '127.0.0.1');

// ------ HTTP + WebSocket ------
const httpServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([...state.agents.values()]));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/feeds') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state.feeds.slice(-50)));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/topology') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ weights: conceptWeights, telemetryCount: state.telemetryCount }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/feed') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const feed = JSON.parse(body);
        handleNeuralFeed(feed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/vault-node') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const node = JSON.parse(body);
        if (!node.id) throw new Error('vault node missing id');
        state.vaultNodes.set(node.id, node);
        broadcast({ type: 'VAULT_NODE', data: node });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/vault-delete') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        if (id && state.vaultNodes.delete(id)) {
          broadcast({ type: 'VAULT_NODE_DELETE', data: { id } });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/vault-nodes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([...state.vaultNodes.values()]));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/vault-synapse') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const s = JSON.parse(body);
        if (!s.sourceLabel || !s.targetLabel) throw new Error('sourceLabel + targetLabel required');
        // Broadcast — vault-writer picks this up over WS and persists to .md
        broadcast({ type: 'VAULT_SYNAPSE', data: s });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/agent-thought') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const t = JSON.parse(body);
        if (!t.feedId || !t.agentId || !t.thought) throw new Error('feedId, agentId, thought required');
        broadcast({ type: 'AGENT_THOUGHT', data: t });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/vault-content')) {
    try {
      const url = new URL(req.url, 'http://x');
      const id = url.searchParams.get('id');
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'id required' }));
        return;
      }
      const node = state.vaultNodes.get(id);
      if (!node || !node.file) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      // Safety: resolve and confirm the path is inside VAULT_PATH
      const absolute = normalize(join(VAULT_PATH, node.file));
      if (!absolute.startsWith(normalize(VAULT_PATH) + '/')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path escape' }));
        return;
      }
      readFile(absolute, 'utf-8')
        .then(content => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, file: node.file, content }));
        })
        .catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  if (req.method === 'GET' && req.url.startsWith('/api/observations')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([...state.observations.values()]));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  state.clients.add(ws);
  console.log(`[broker] WS client connected (${state.clients.size} total)`);

  ws.send(JSON.stringify({
    type: 'INIT',
    data: {
      agents: [...state.agents.values()],
      feeds: state.feeds.slice(-20),
      topology: conceptWeights,
      vaultNodes: [...state.vaultNodes.values()],
      observations: [...state.observations.values()].slice(-200),
    },
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'NEURAL_FEED') handleNeuralFeed(msg.data || msg);
    } catch {}
  });

  ws.on('close', () => {
    state.clients.delete(ws);
    console.log(`[broker] WS client disconnected (${state.clients.size} total)`);
  });
});

// Agent idle detection
setInterval(() => {
  const now = Date.now();
  for (const [id, agent] of state.agents) {
    if (now - agent.lastActive > 120000 && agent.status !== 'idle') {
      agent.status = 'idle';
      broadcast({ type: 'AGENT_UPDATE', data: agent });
    }
  }
}, HEARTBEAT_INTERVAL);

// --- Ambient neural activity generator ---
// Continuously fires synthetic feeds so the brain is always alive with sprites
const AMBIENT_AGENTS = [
  { id: 'CORTEX_SCANNER', sector: 'PREFRONTAL', color: '#ff3b30', summaries: ['scanning decision trees', 'evaluating priority queue', 'prefrontal sweep active'] },
  { id: 'KNOWLEDGE_WEAVER', sector: 'CONCEPT_LAYER', color: '#ff9500', summaries: ['linking concepts', 'embedding new relations', 'pattern synthesis'] },
  { id: 'SENSORY_INTAKE', sector: 'SENSORY_CORTEX', color: '#00e5f0', summaries: ['processing input stream', 'signal normalization', 'sensory buffer flush'] },
  { id: 'MEMORY_INDEXER', sector: 'HIPPOCAMPUS', color: '#4cd964', summaries: ['indexing episodic memory', 'consolidating traces', 'recall pathway active'] },
  { id: 'MOTOR_PLANNER', sector: 'CEREBELLUM', color: '#e633b4', summaries: ['coordinating build pipeline', 'motor sequence queued', 'execution plan ready'] },
  { id: 'TEMPORAL_SYNC', sector: 'TEMPORAL', color: '#f59e0b', summaries: ['temporal alignment', 'sequence prediction', 'chronology update'] },
  { id: 'SPATIAL_MAP', sector: 'PARIETAL', color: '#34d399', summaries: ['mapping spatial relations', 'topology refresh', 'coordinate update'] },
  { id: 'VISUAL_PROCESS', sector: 'OCCIPITAL', color: '#818cf8', summaries: ['visual cortex active', 'rendering pipeline', 'pattern recognition'] },
];

const AMBIENT_NODES = ['vault', 'obsidian', 'graph', 'memory', 'concept', 'project', 'session', 'decision', 'architecture', 'synthesis', 'discovery', 'entity'];

function fireAmbientPulse() {
  const agent = AMBIENT_AGENTS[Math.floor(Math.random() * AMBIENT_AGENTS.length)];
  const summary = agent.summaries[Math.floor(Math.random() * agent.summaries.length)];
  const srcNode = AMBIENT_NODES[Math.floor(Math.random() * AMBIENT_NODES.length)];
  const tgtNode = AMBIENT_NODES[Math.floor(Math.random() * AMBIENT_NODES.length)];

  const feed = {
    agentId: agent.id,
    targetSector: agent.sector,
    intensity: 0.3 + Math.random() * 0.6,
    synapticAssociations: [{
      sourceNode: srcNode,
      targetNode: tgtNode,
      weight: 0.4 + Math.random() * 0.5,
    }],
    payloadSummary: summary,
  };

  handleNeuralFeed(feed);

  broadcast({
    type: 'SYNAPSE_ACTIVATION',
    meta: { command: summary, directory: '/sypher', success: true },
    agent: {
      identifier: agent.id,
      hexColor: agent.color,
      targetSector: agent.sector,
      vectorTarget: conceptWeights[agent.sector]?.coordinates || [0, 0, 0],
    },
    dynamics: { intensity: feed.intensity, timestamp: Date.now() },
  });
}

// Fire ambient pulses every 2-5 seconds (randomized for organic feel)
function scheduleNextPulse() {
  const delay = 2000 + Math.random() * 3000;
  setTimeout(() => {
    if (state.clients.size > 0) fireAmbientPulse();
    scheduleNextPulse();
  }, delay);
}
scheduleNextPulse();

// --- claude-mem observation tailer ---
// Polls the claude-mem HTTP API every 1s, broadcasts OBSERVATION_NEW for any
// observation whose id is greater than the highest we've seen.
const CLAUDE_MEM_API = process.env.CLAUDE_MEM_API || 'http://127.0.0.1:37777';

async function pollObservations() {
  try {
    const res = await fetch(`${CLAUDE_MEM_API}/api/observations?limit=50`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return;
    const data = await res.json();
    const items = Array.isArray(data) ? data : data.items || data.observations || [];
    if (!items.length) return;

    // Items come newest-first; iterate oldest-first so order on the wire is sane.
    const fresh = items
      .filter(o => o && typeof o.id === 'number' && o.id > state.lastObservationId)
      .sort((a, b) => a.id - b.id);

    for (const obs of fresh) {
      state.observations.set(obs.id, obs);
      if (obs.id > state.lastObservationId) state.lastObservationId = obs.id;
      broadcast({ type: 'OBSERVATION_NEW', data: obs });
    }
    if (fresh.length) {
      console.log(`[broker] obs-tail: +${fresh.length} (latest id=${state.lastObservationId})`);
    }
  } catch (err) {
    // Silent — claude-mem may be restarting
  }
}

async function seedObservations() {
  try {
    const res = await fetch(`${CLAUDE_MEM_API}/api/observations?limit=200`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const items = Array.isArray(data) ? data : data.items || data.observations || [];
    for (const obs of items) {
      if (obs && typeof obs.id === 'number') {
        state.observations.set(obs.id, obs);
        if (obs.id > state.lastObservationId) state.lastObservationId = obs.id;
      }
    }
    console.log(`[broker] obs-seed: ${state.observations.size} observations (max id=${state.lastObservationId})`);
  } catch {
    console.log('[broker] obs-seed: claude-mem unreachable, will retry');
  }
}

httpServer.listen(HTTP_PORT, '127.0.0.1', async () => {
  console.log(`[broker] SYPHER Brain Neuromorphic Broker`);
  console.log(`[broker] HTTP/WS: http://127.0.0.1:${HTTP_PORT}`);
  console.log(`[broker] UDP:     udp://127.0.0.1:${UDP_PORT}`);
  console.log(`[broker] Topology: ${Object.keys(conceptWeights).length} sectors active`);
  console.log(`[broker] Ambient: auto-pulse active (2-5s interval when clients connected)`);
  console.log(`[broker] Tailer:  polling ${CLAUDE_MEM_API}/api/observations every 1s`);

  await seedObservations();
  setInterval(pollObservations, 1000);
  // Load bge sector anchors for the real-model command classifier
  loadAnchors();
});
