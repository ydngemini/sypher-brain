/**
 * SYPHER Brain — Vault Writer
 *
 * When the brain forms a semantic synapse between two vault notes, this
 * service appends a [[target]] wikilink to the source note's "## Brain Links"
 * section. Obsidian reads the same .md files, so its graph view immediately
 * picks up the new connection.
 *
 * Idempotent: a link is only added if it isn't already present in the file
 * (either in Brain Links or elsewhere in the body).
 *
 * Cycle-safe: vault-bridge watches the file and re-emits a VAULT_NODE event
 * when we save. The brain treats that as a normal update — same node id,
 * same cached position, just an extended links list. No re-fired semantic
 * synapse triggers another writeback (vector embed is cached).
 *
 * Throttled: at most one writeback per source file per WINDOW_MS, deduped
 * within the window so a burst of synapses to the same note coalesces.
 */
import WebSocket from 'ws';
import { readFile, writeFile, stat } from 'fs/promises';
import { join, normalize } from 'path';

const BROKER_WS = process.env.BROKER_WS || 'ws://127.0.0.1:9800';
const VAULT_PATH = process.env.VAULT_PATH || '/media/ydn/SYPHER_CORE/SYPHER_VAULT';
const WINDOW_MS = 30_000;            // per-file write debounce
const MIN_SCORE_FOR_PERSIST = 0.62;  // tighter threshold than display synapses

const BRAIN_LINKS_HEADER = '## Brain Links';
const BRAIN_LINKS_NOTE =
  '\n_Auto-maintained by SYPHER Brain — semantic neighbors learned from this vault._';

// Per-file pending writes: Map<filePath, { pendingLinks: Set<string>, timer }>
const pending = new Map();

function safeVaultPath(relPath) {
  if (!relPath || typeof relPath !== 'string') return null;
  if (relPath.includes('..')) return null;
  const abs = normalize(join(VAULT_PATH, relPath));
  if (!abs.startsWith(normalize(VAULT_PATH) + '/')) return null;
  if (!abs.endsWith('.md')) return null;
  return abs;
}

function scheduleWrite(sourceFile, targetLabel) {
  const abs = safeVaultPath(sourceFile);
  if (!abs) return;
  if (!targetLabel) return;

  let p = pending.get(abs);
  if (!p) {
    p = { pendingLinks: new Set(), timer: null };
    pending.set(abs, p);
  }
  p.pendingLinks.add(targetLabel);

  if (p.timer) return; // already scheduled
  p.timer = setTimeout(() => {
    const links = [...p.pendingLinks];
    pending.delete(abs);
    flushWrite(abs, links).catch(err => {
      console.error(`[vault-writer] flush failed for ${abs}: ${err.message}`);
    });
  }, WINDOW_MS);
}

async function flushWrite(absPath, newLinks) {
  let content;
  try {
    content = await readFile(absPath, 'utf-8');
  } catch (err) {
    console.error(`[vault-writer] cannot read ${absPath}: ${err.message}`);
    return;
  }

  const existingLinkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const existing = new Set();
  let m;
  while ((m = existingLinkPattern.exec(content)) !== null) {
    existing.add(m[1].trim().toLowerCase());
  }

  const toAdd = newLinks.filter(l => !existing.has(l.toLowerCase()));
  if (toAdd.length === 0) {
    return; // every proposed link already exists in the file
  }

  const headerIdx = content.indexOf(BRAIN_LINKS_HEADER);
  let updated;
  if (headerIdx === -1) {
    // Append a new section at the end
    const block = `\n\n${BRAIN_LINKS_HEADER}\n${BRAIN_LINKS_NOTE}\n${toAdd.map(l => `- [[${l}]]`).join('\n')}\n`;
    updated = content.replace(/\s*$/, '') + block + '\n';
  } else {
    // Insert into the existing section. Find where this section ends (next
    // header or EOF) and append our new bullets before it.
    const after = content.slice(headerIdx);
    const nextHeaderRel = after.slice(BRAIN_LINKS_HEADER.length).search(/\n## /);
    const sectionEnd = nextHeaderRel === -1
      ? content.length
      : headerIdx + BRAIN_LINKS_HEADER.length + nextHeaderRel;

    const insertion = '\n' + toAdd.map(l => `- [[${l}]]`).join('\n');
    updated = content.slice(0, sectionEnd).replace(/\s*$/, '') + insertion + '\n' + content.slice(sectionEnd);
  }

  try {
    await writeFile(absPath, updated, 'utf-8');
    console.log(`[vault-writer] +${toAdd.length} links → ${absPath.slice(VAULT_PATH.length + 1)}: ${toAdd.join(', ')}`);
  } catch (err) {
    console.error(`[vault-writer] write failed for ${absPath}: ${err.message}`);
  }
}

let ws = null;
let backoff = 1000;

function connect() {
  ws = new WebSocket(BROKER_WS);

  ws.on('open', () => {
    console.log('[vault-writer] broker WS connected');
    backoff = 1000;
  });

  ws.on('close', () => {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  });

  ws.on('error', (err) => {
    console.error(`[vault-writer] WS error: ${err.message}`);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'VAULT_SYNAPSE' && msg.data) {
        const d = msg.data;
        if ((d.score ?? 1) < MIN_SCORE_FOR_PERSIST) return;
        if (!d.sourceFile || !d.targetLabel) return;
        scheduleWrite(d.sourceFile, d.targetLabel);
        // Also schedule the reverse so both notes know about the relation —
        // that mirrors how Obsidian users would draw bidirectional links.
        if (d.targetFile && d.sourceLabel) {
          scheduleWrite(d.targetFile, d.sourceLabel);
        }
      }
    } catch {}
  });
}

console.log('[vault-writer] SYPHER Vault Writer starting');
console.log(`[vault-writer] Vault:  ${VAULT_PATH}`);
console.log(`[vault-writer] Broker: ${BROKER_WS}`);
console.log(`[vault-writer] Debounce: ${WINDOW_MS}ms, min score: ${MIN_SCORE_FOR_PERSIST}`);
connect();
