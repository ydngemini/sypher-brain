/**
 * BGE-driven sector/category classifier shared by broker and vault-bridge.
 *
 * Given a list of anchor texts (one per class), the classifier embeds the
 * anchors once via the bge-small-en ONNX server and caches the vectors.
 * Per-query: embed the input, cosine-match against the cached anchors,
 * return the top class with its confidence.
 *
 * Math-true classification — every routing decision is a real transformer
 * inference, not a regex or directory lookup.
 */

const EMBED_URL = process.env.EMBED_URL || 'http://127.0.0.1:5175';

export class BgeClassifier {
  constructor(anchors, opts = {}) {
    // anchors: [{ label, text, ...userData }]
    this.anchors = anchors;
    this.vectors = null;
    this.cache = new Map();
    this.cacheMax = opts.cacheMax || 500;
    this.loaded = this._init();
  }

  async _init() {
    // Retry the anchor embedding until the embed server is reachable.
    for (let i = 0; i < 120; i++) {
      try {
        const texts = this.anchors.map(a => a.text);
        const res = await fetch(`${EMBED_URL}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`embed ${res.status}`);
        const data = await res.json();
        const vs = data.embeddings;
        if (!Array.isArray(vs) || vs.length !== this.anchors.length) throw new Error('vec count mismatch');
        this.vectors = vs.map(v => new Float32Array(v));
        return true;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    return false;
  }

  async classify(text) {
    if (!this.vectors) return null;
    if (!text) return null;
    const cached = this.cache.get(text);
    if (cached) return cached;

    let queryVec;
    try {
      const res = await fetch(`${EMBED_URL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: [text] }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const v = data.embeddings?.[0];
      if (!v) return null;
      queryVec = new Float32Array(v);
    } catch {
      return null;
    }

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < this.anchors.length; i++) {
      let s = 0;
      const av = this.vectors[i];
      for (let k = 0; k < queryVec.length; k++) s += queryVec[k] * av[k];
      if (s > bestScore) { bestScore = s; best = this.anchors[i]; }
    }
    const result = { ...best, _score: bestScore };
    this.cache.set(text, result);
    if (this.cache.size > this.cacheMax) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    return result;
  }
}
