import dgram from 'dgram';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const HTTP_PORT = 9800;
const UDP_PORT = 3456;
const HEARTBEAT_INTERVAL = 30000;

// Topological Adjacency Matrix — live weight space for neuromorphic routing
const conceptWeights = {
  PREFRONTAL:    { coordinates: [5.0, 2.0, 0.0],   baseColor: [1.0, 0.23, 0.19] },
  CONCEPT_LAYER: { coordinates: [0.0, 4.0, 2.0],   baseColor: [1.0, 0.58, 0.0] },
  CONTEXT_CORTEX:{ coordinates: [3.0, 1.0, 3.0],   baseColor: [0.13, 0.83, 0.83] },
  TEMPORAL:      { coordinates: [-4.0, -1.0, 2.0],  baseColor: [1.0, 0.62, 0.04] },
  PARIETAL:      { coordinates: [0.0, 5.0, -1.0],   baseColor: [0.2, 0.8, 0.4] },
  OCCIPITAL:     { coordinates: [0.0, 0.0, -5.0],   baseColor: [0.5, 0.55, 0.97] },
  HIPPOCAMPUS:   { coordinates: [-3.0, -2.0, 4.0],  baseColor: [0.30, 0.85, 0.39] },
  CEREBELLUM:    { coordinates: [2.0, -5.0, -3.0],  baseColor: [0.35, 0.78, 0.98] },
};

// Command → agent/sector classification
function dissectCommandContext(cmd) {
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
    return { agentName: 'NET_CONDUIT', color: '#22d3ee', targetSector: 'CONTEXT_CORTEX' };
  if (/^(cat|less|head|tail|bat|jq|yq)$/.test(root))
    return { agentName: 'READ_STREAM', color: '#818cf8', targetSector: 'OCCIPITAL' };
  if (/^(cd|ls|ll|tree|pwd|mkdir|rm|mv|cp)$/.test(root))
    return { agentName: 'FS_NAVIGATOR', color: '#34d399', targetSector: 'PARIETAL' };

  return { agentName: 'SYSTEM_KERNEL', color: '#00f3ff', targetSector: 'PREFRONTAL' };
}

// ------ State ------
const state = {
  agents: new Map(),
  feeds: [],
  clients: new Set(),
  telemetryCount: 0,
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

udpServer.on('message', (msg) => {
  try {
    const telemetry = JSON.parse(msg.toString());
    if (!telemetry.cmd) return;

    state.telemetryCount++;
    const analysis = dissectCommandContext(telemetry.cmd);
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

httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[broker] SYPHER Brain Neuromorphic Broker`);
  console.log(`[broker] HTTP/WS: http://127.0.0.1:${HTTP_PORT}`);
  console.log(`[broker] UDP:     udp://127.0.0.1:${UDP_PORT}`);
  console.log(`[broker] Topology: ${Object.keys(conceptWeights).length} sectors active`);
});
