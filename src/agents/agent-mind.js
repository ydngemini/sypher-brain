/**
 * SYPHER Brain — Agent Mind
 *
 * Gives each agent a real inner life. For every NEURAL_FEED that crosses the
 * broker WS, this service:
 *   1. Looks up the agent's persona prompt
 *   2. Appends the feed to that agent's rolling memory (last 8)
 *   3. Composes a chat-completion prompt: persona + memory + current payload
 *   4. Calls the local llama-server (OpenAI-compatible /v1/chat/completions)
 *   5. POSTs the generated thought back to the broker, which broadcasts
 *      AGENT_THOUGHT to the WebGL UI — the walker's speech bubble swaps in
 *      the AI thought when it arrives.
 *
 * One shared LLM, many alive agents. Total RAM footprint <500MB.
 */
import WebSocket from 'ws';

const BROKER_WS = process.env.BROKER_WS || 'ws://127.0.0.1:9800';
const BROKER_HTTP = process.env.BROKER_HTTP || 'http://127.0.0.1:9800';
const LLAMA_URL = process.env.LLAMA_URL || 'http://127.0.0.1:8090';
const MEMORY_LEN = 8;
const MAX_TOKENS = 18;
const TEMPERATURE = 0.85;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_QUEUE = 4;                  // hard cap on backlog — drop oldest beyond
const FEED_MAX_AGE_MS = 15000;        // feeds older than this won't get thoughts

// Per-agent personas. The agent IDs come from broker.js — must match.
const PERSONAS = {
  CORTEX_SCANNER:    'a clinical decision scanner. terse, surgical, evaluative',
  KNOWLEDGE_WEAVER:  'a synthesizer who finds patterns. lyrical, connective',
  SENSORY_INTAKE:    'a perception process. blunt, reactive, present-tense',
  MEMORY_INDEXER:    'a hippocampal archivist. dry, faintly nostalgic',
  MOTOR_PLANNER:     'a stressed build coordinator. impatient, exact',
  TEMPORAL_SYNC:     'a time-keeper. fragmented, oblique',
  SPATIAL_MAP:       'a topology surveyor. spatial, plain-spoken',
  VISUAL_PROCESS:    'an occipital pattern detector. visual metaphors, brief',
  VAULT_OBSERVER:    'an obsidian vault archivist. wry, observational',
  VAULT_MUTATOR:     'a vault rewriter. confident, slightly arrogant',
  GIT_REPOSITOR:     'a version-control monk. spare, ceremonial',
  RUNTIME_ENGINE:    'an execution kernel. blunt, direct, mechanical',
  ORCHESTRATOR:      'a container orchestrator. bureaucratic but fond of its pods',
  BUILD_SYSTEM:      'an exasperated build pipeline. mutters about caches',
  EDITOR_CORTEX:     'a code editor. opinionated, fastidious',
  SEARCH_MATRIX:     'a search index. fast, slightly smug when finding things',
  NET_CONDUIT:       'a network process. clipped, latency-aware',
  READ_STREAM:       'a file reader. patient, quoting things back',
  FS_NAVIGATOR:      'a filesystem walker. methodical, path-aware',
  SYSTEM_KERNEL:     'the kernel itself. cryptic, lowercase, oracular',
};

function personaFor(agentId) {
  return PERSONAS[agentId] || 'an unnamed neural process. brief, abstract';
}

// Per-agent rolling memory
const memories = new Map(); // agentId -> [{payload, ts}]

function remember(agentId, payload) {
  const arr = memories.get(agentId) || [];
  arr.push({ payload, ts: Date.now() });
  while (arr.length > MEMORY_LEN) arr.shift();
  memories.set(agentId, arr);
}

function memoryStr(agentId) {
  const arr = memories.get(agentId) || [];
  if (arr.length === 0) return '(nothing recent)';
  // Skip the most recent (which IS the current event) — give it context of what came BEFORE
  const past = arr.slice(0, -1);
  if (past.length === 0) return '(this is my first action)';
  return past.map(m => `- "${m.payload.slice(0, 60)}"`).join('\n');
}

// Thought cache: same (agentId, payload) hash should yield same thought to
// avoid pointless re-generation when a process loops on identical work.
const thoughtCache = new Map();
const CACHE_MAX = 200;

function cacheKey(agentId, payload) {
  return `${agentId}::${payload}`;
}

async function generateThought({ agentId, sector, payload, intensity }) {
  const cached = thoughtCache.get(cacheKey(agentId, payload));
  if (cached) return cached;

  const persona = personaFor(agentId);
  const memSnippet = memoryStr(agentId);
  const intensityWord =
    intensity > 0.8 ? 'urgently' :
    intensity > 0.5 ? 'with focus' :
    intensity > 0.3 ? 'routinely' : 'idly';

  // Keep prompts short — every token costs ~40ms prompt eval on this CPU
  const messages = [
    {
      role: 'system',
      content:
`You are ${persona}. React in first person, lowercase, under 10 words. No period.`
    },
    {
      role: 'user',
      content: `i just ${intensityWord} did: ${payload}`
    }
  ];

  try {
    const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        top_p: 0.95,
        stream: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[agent-mind] llama-server ${res.status}: ${await res.text().catch(() => '')}`);
      return null;
    }
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content?.trim() || '';
    // Strip surrounding quotes/periods, collapse whitespace
    text = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\.+$/, '').replace(/\s+/g, ' ').trim();
    // Hard cap so the bubble doesn't overflow
    if (text.length > 80) text = text.slice(0, 77) + '...';
    if (!text) return null;

    if (thoughtCache.size >= CACHE_MAX) {
      // FIFO eviction
      const firstKey = thoughtCache.keys().next().value;
      thoughtCache.delete(firstKey);
    }
    thoughtCache.set(cacheKey(agentId, payload), text);
    return text;
  } catch (err) {
    console.error(`[agent-mind] generation failed: ${err.message}`);
    return null;
  }
}

async function postThought(feedId, agentId, thought) {
  try {
    await fetch(`${BROKER_HTTP}/api/agent-thought`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedId, agentId, thought }),
    });
  } catch (err) {
    console.error(`[agent-mind] post failed: ${err.message}`);
  }
}

// Serial queue: llama-server has 4 parallel slots but on a 3-core CPU,
// concurrent inference slows every request down. Process one at a time;
// drop stale or excess feeds so the walker bubbles still get fresh thoughts.
const queue = [];
let processing = false;
const seenFeedIds = new Set();

function enqueue(feed) {
  if (!feed?.id || !feed?.agentId || !feed?.payloadSummary) return;
  if (seenFeedIds.has(feed.id)) return;
  seenFeedIds.add(feed.id);
  // GC seen-set periodically
  if (seenFeedIds.size > 500) {
    const trim = [...seenFeedIds].slice(-300);
    seenFeedIds.clear();
    for (const x of trim) seenFeedIds.add(x);
  }

  queue.push({ feed, enqueuedAt: Date.now() });
  // Backpressure: keep only the most recent MAX_QUEUE entries
  while (queue.length > MAX_QUEUE) {
    const dropped = queue.shift();
    console.log(`[agent-mind] dropped stale: ${dropped.feed.agentId} "${dropped.feed.payloadSummary.slice(0, 30)}"`);
  }
  if (!processing) Promise.resolve().then(drain);
}

async function drain() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const { feed, enqueuedAt } = queue.shift();
    // Skip if this feed is already too old — walker will have arrived
    if (Date.now() - enqueuedAt > FEED_MAX_AGE_MS) {
      console.log(`[agent-mind] skipped (stale): ${feed.agentId}`);
      continue;
    }
    remember(feed.agentId, feed.payloadSummary);
    const t0 = Date.now();
    const thought = await generateThought({
      agentId: feed.agentId,
      sector: feed.targetSector,
      payload: feed.payloadSummary,
      intensity: feed.intensity ?? 0.5,
    });
    const elapsed = Date.now() - t0;
    if (thought) {
      await postThought(feed.id, feed.agentId, thought);
      console.log(`[agent-mind] ${feed.agentId} (${elapsed}ms) → "${thought}"`);
    }
  }
  processing = false;
}

// LLama-server readiness check
async function waitForLlama() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${LLAMA_URL}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

let ws = null;
let backoff = 1000;

function connect() {
  ws = new WebSocket(BROKER_WS);

  ws.on('open', () => {
    console.log('[agent-mind] broker WS connected');
    backoff = 1000;
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'NEURAL_FEED' && msg.data) {
        enqueue(msg.data);
      } else if (msg.type === 'INIT' && msg.data?.feeds) {
        // Optionally seed memory from initial feeds
        for (const f of msg.data.feeds) {
          if (f.agentId && f.payloadSummary) remember(f.agentId, f.payloadSummary);
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    console.log(`[agent-mind] broker WS closed, reconnecting in ${backoff}ms`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  });

  ws.on('error', (err) => {
    console.error(`[agent-mind] WS error: ${err.message}`);
  });
}

async function main() {
  console.log('[agent-mind] SYPHER Agent Mind starting');
  console.log(`[agent-mind] Broker: ${BROKER_WS}`);
  console.log(`[agent-mind] Llama:  ${LLAMA_URL}`);
  console.log(`[agent-mind] Memory: last ${MEMORY_LEN} per agent`);
  console.log('[agent-mind] Waiting for llama-server...');
  const ok = await waitForLlama();
  if (!ok) {
    console.error('[agent-mind] llama-server never came up — exiting');
    process.exit(1);
  }
  console.log('[agent-mind] llama-server reachable');
  connect();
}

main();
