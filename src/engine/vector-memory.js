/**
 * Vector memory for the brain.
 *
 * Each neuron (vault, observation, feed) gets its label/payload embedded by
 * the bge-small-en ONNX server at :5175 the first time it appears. The
 * 384-dim vector is cached per nodeId. When a new neuron is added, we query
 * for the top-K most similar existing neurons by cosine similarity — those
 * become semantic synapses, real connections grounded in meaning, not just
 * label-substring matches or random clustering.
 *
 * Bounded candidate pool keeps the per-query cost flat as the brain grows.
 */

const EMBED_SERVER = 'http://127.0.0.1:5175';
const VECTOR_DIM = 384;
const MAX_VECTORS = 4000;      // hard cap on stored vectors (FIFO eviction)
const CANDIDATE_POOL = 1500;   // similarity searches the most-recent N vectors

export class VectorMemory {
  constructor() {
    // Insertion order matters for FIFO eviction → use a Map.
    this.vectors = new Map();      // nodeId -> { vec: Float32Array, label: string }
    this.pendingEmbeds = new Map(); // nodeId -> Promise<vec>
    this._idsRing = [];            // recency ring for the candidate pool
  }

  /**
   * Embed a node's label/payload and store its vector. Returns the vector.
   * If an embed is already in-flight for this id, returns the existing promise
   * so we don't double-bill the embed server.
   */
  async embed(nodeId, text) {
    if (!text) return null;
    if (this.vectors.has(nodeId)) return this.vectors.get(nodeId).vec;
    if (this.pendingEmbeds.has(nodeId)) return this.pendingEmbeds.get(nodeId);

    const p = (async () => {
      try {
        const res = await fetch(`${EMBED_SERVER}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts: [text] }),
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const raw = data.embeddings?.[0];
        if (!raw || raw.length !== VECTOR_DIM) return null;
        const vec = new Float32Array(raw);
        this._store(nodeId, vec, text);
        return vec;
      } catch {
        return null;
      } finally {
        this.pendingEmbeds.delete(nodeId);
      }
    })();
    this.pendingEmbeds.set(nodeId, p);
    return p;
  }

  _store(nodeId, vec, label) {
    if (this.vectors.has(nodeId)) {
      this.vectors.set(nodeId, { vec, label });
      return;
    }
    this.vectors.set(nodeId, { vec, label });
    this._idsRing.push(nodeId);
    if (this.vectors.size > MAX_VECTORS) {
      // Evict oldest until under cap
      while (this.vectors.size > MAX_VECTORS) {
        const oldId = this._idsRing.shift();
        if (oldId) this.vectors.delete(oldId);
      }
    }
  }

  /**
   * Return top-K most similar nodeIds to the given vector, excluding `excludeId`.
   * Searches at most CANDIDATE_POOL most-recent vectors so cost stays bounded
   * as the brain grows to 1M neurons.
   */
  topK(queryVec, K = 3, excludeId = null, minScore = 0.45) {
    if (!queryVec) return [];
    const candidates = this._idsRing.slice(-CANDIDATE_POOL);
    const scored = [];
    for (const id of candidates) {
      if (id === excludeId) continue;
      const entry = this.vectors.get(id);
      if (!entry) continue;
      const s = cosine(queryVec, entry.vec);
      if (s >= minScore) scored.push({ id, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, K);
  }

  size() { return this.vectors.size; }
}

function cosine(a, b) {
  let dot = 0;
  // bge embeddings are L2-normalized server-side, so dot product == cosine
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
