"""
SYPHER Brain Embedding Server
Computes embeddings for observation/concept labels using bge-small-en ONNX
and projects to 2D via UMAP for spatial layout in the brain visualizer.

Run: python3 embed-server.py
Serves: http://localhost:5175/api/positions
"""
import json
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import numpy as np

# ONNX model path (same one SYPHER IDE uses)
MODEL_DIR = "/media/ydn/SYPHER_CORE/YDNIDE/.sypher/models/models--qdrant--bge-small-en-v1.5-onnx-q/snapshots/52398278842ec682c6f32300af41344b1c0b0bb2"

# Lazy-loaded globals
_session = None
_tokenizer = None
_umap = None


def load_model():
    global _session, _tokenizer
    if _session is not None:
        return

    import onnxruntime as ort
    from tokenizers import Tokenizer

    model_path = os.path.join(MODEL_DIR, "model_optimized.onnx")
    tokenizer_path = os.path.join(MODEL_DIR, "tokenizer.json")

    _session = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
    _tokenizer = Tokenizer.from_file(tokenizer_path)
    _tokenizer.enable_truncation(max_length=512)
    _tokenizer.enable_padding(length=512)
    print(f"[embed-server] Model loaded from {MODEL_DIR}")


def embed_texts(texts):
    """Compute embeddings for a list of texts. Returns (N, 384) array."""
    load_model()

    encodings = _tokenizer.encode_batch(texts)
    input_ids = np.array([e.ids for e in encodings], dtype=np.int64)
    attention_mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
    token_type_ids = np.zeros_like(input_ids, dtype=np.int64)

    outputs = _session.run(
        None,
        {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
            "token_type_ids": token_type_ids
        }
    )

    # Mean pooling over token embeddings
    token_embeddings = outputs[0]  # (batch, seq_len, hidden_dim)
    mask_expanded = attention_mask[:, :, np.newaxis].astype(np.float32)
    sum_embeddings = (token_embeddings * mask_expanded).sum(axis=1)
    sum_mask = mask_expanded.sum(axis=1).clip(min=1e-9)
    embeddings = sum_embeddings / sum_mask

    # L2 normalize
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True).clip(min=1e-9)
    return embeddings / norms


def project_to_2d(embeddings, n_neighbors=15, min_dist=0.3):
    """UMAP projection from high-dim embeddings to 2D positions."""
    try:
        from umap import UMAP
    except ImportError:
        # Fallback: PCA if UMAP not installed
        from sklearn.decomposition import PCA
        pca = PCA(n_components=2)
        return pca.fit_transform(embeddings)

    reducer = UMAP(
        n_components=2,
        n_neighbors=min(n_neighbors, len(embeddings) - 1),
        min_dist=min_dist,
        metric='cosine',
        random_state=42
    )
    return reducer.fit_transform(embeddings)


# Cache for positions
_position_cache = {}
_cache_hash = None


def compute_positions(nodes):
    """Given a list of {id, label} dicts, return {id: {x, y}} positions."""
    global _position_cache, _cache_hash

    # Check cache
    current_hash = hash(tuple(sorted(n['id'] for n in nodes)))
    if current_hash == _cache_hash and _position_cache:
        return _position_cache

    if len(nodes) < 3:
        # Too few for UMAP, use random
        result = {n['id']: {'x': np.random.uniform(-500, 500), 'y': np.random.uniform(-500, 500)} for n in nodes}
        _position_cache = result
        _cache_hash = current_hash
        return result

    texts = [n['label'] for n in nodes]
    embeddings = embed_texts(texts)
    positions_2d = project_to_2d(embeddings)

    # Scale to reasonable coordinate range
    positions_2d = positions_2d * 500

    result = {}
    for i, node in enumerate(nodes):
        result[node['id']] = {
            'x': float(positions_2d[i, 0]),
            'y': float(positions_2d[i, 1])
        }

    _position_cache = result
    _cache_hash = current_hash
    return result


def compute_similarity(query, labels):
    """Compute cosine similarity between query and all labels."""
    all_texts = [query] + labels
    embeddings = embed_texts(all_texts)
    query_emb = embeddings[0:1]
    label_embs = embeddings[1:]
    similarities = (query_emb @ label_embs.T).flatten()
    return similarities.tolist()


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(content_length)) if content_length else {}

        if self.path == '/api/positions':
            nodes = body.get('nodes', [])
            if not nodes:
                self._json_response({'error': 'nodes array required'}, 400)
                return
            try:
                positions = compute_positions(nodes)
                self._json_response({'positions': positions})
            except Exception as e:
                self._json_response({'error': str(e)}, 500)

        elif self.path == '/api/similarity':
            query = body.get('query', '')
            labels = body.get('labels', [])
            if not query or not labels:
                self._json_response({'error': 'query and labels required'}, 400)
                return
            try:
                scores = compute_similarity(query, labels)
                self._json_response({'scores': scores})
            except Exception as e:
                self._json_response({'error': str(e)}, 500)

        elif self.path == '/api/embed':
            texts = body.get('texts', [])
            if not texts:
                self._json_response({'error': 'texts array required'}, 400)
                return
            try:
                embeddings = embed_texts(texts)
                self._json_response({'embeddings': embeddings.tolist()})
            except Exception as e:
                self._json_response({'error': str(e)}, 500)

        else:
            self._json_response({'error': 'not found'}, 404)

    def do_GET(self):
        if self.path == '/api/health':
            self._json_response({'status': 'ok', 'model': 'bge-small-en-v1.5-onnx-q'})
        else:
            self._json_response({'error': 'not found'}, 404)

    def _json_response(self, data, status=200):
        self.send_response(status)
        self._cors_headers()
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, format, *args):
        print(f"[embed-server] {args[0]}")


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5175
    server = HTTPServer(('127.0.0.1', port), Handler)
    print(f"[embed-server] SYPHER Brain Embedding Server on http://127.0.0.1:{port}")
    print(f"[embed-server] Endpoints: POST /api/positions, POST /api/similarity, POST /api/embed, GET /api/health")
    server.serve_forever()
