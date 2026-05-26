import { useEffect, useState } from 'react';

const SECTOR_COLORS = {
  PREFRONTAL: '#ff3b30',
  CONCEPT_LAYER: '#ff9500',
  SENSORY_CORTEX: '#00e5f0',
  HIPPOCAMPUS: '#4cd964',
  CEREBELLUM: '#e633b4',
  TEMPORAL: '#f59e0b',
  PARIETAL: '#34d399',
  OCCIPITAL: '#818cf8',
};

const BROKER_HTTP = 'http://127.0.0.1:9800';

// Lightweight markdown → safe HTML. No deps. Handles headers, bold, code,
// inline code, lists, blockquotes, hr, links, [[wikilinks]].
function renderMarkdown(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const out = [];
  let inCode = false;
  let inList = false;
  let codeBuf = [];

  const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) =>
        `<a class="wikilink" data-target="${target}">${label || target}</a>`)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  const flushList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    if (!line.trim()) { flushList(); continue; }

    if (/^---+$/.test(line.trim())) { flushList(); out.push('<hr/>'); continue; }

    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { flushList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^[-*+]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.replace(/^[-*+]\s+/, ''))}</li>`);
      continue;
    }

    if (/^>\s+/.test(line)) {
      flushList();
      out.push(`<blockquote>${inline(line.replace(/^>\s+/, ''))}</blockquote>`);
      continue;
    }

    flushList();
    out.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  return out.join('\n');
}

export default function NeuronDetail({ selection, onClose }) {
  const [vaultContent, setVaultContent] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selection) {
      setVaultContent(null);
      return;
    }

    if (selection.sceneNode.source === 'vault') {
      const noteId = selection.sceneNode.id.startsWith('vault:')
        ? selection.sceneNode.id.slice(6)
        : selection.sceneNode.id;
      setLoading(true);
      setVaultContent(null);
      fetch(`${BROKER_HTTP}/api/vault-content?id=${encodeURIComponent(noteId)}`)
        .then(r => r.ok ? r.json() : null)
        .then(j => setVaultContent(j))
        .catch(() => setVaultContent(null))
        .finally(() => setLoading(false));
    }
  }, [selection]);

  if (!selection) return null;

  const { sceneNode, source } = selection;
  const sectorColor = sceneNode.hexColor || '#666';
  const isVault = sceneNode.source === 'vault';

  return (
    <div style={{
      position: 'absolute',
      top: 56,
      right: 16,
      bottom: 16,
      width: 460,
      background: 'rgba(5, 5, 12, 0.96)',
      border: `1px solid ${sectorColor}55`,
      borderRadius: 8,
      backdropFilter: 'blur(14px)',
      boxShadow: `0 8px 36px rgba(0,0,0,0.7), 0 0 24px ${sectorColor}22`,
      display: 'flex',
      flexDirection: 'column',
      color: '#E5E7EB',
      fontFamily: '"JetBrains Mono", monospace',
      zIndex: 80,
      overflow: 'hidden',
    }}>
      <style>{`
        .neuron-detail-body h1, .neuron-detail-body h2, .neuron-detail-body h3 {
          color: #fff; margin: 12px 0 6px; font-weight: 700;
        }
        .neuron-detail-body h1 { font-size: 14px; }
        .neuron-detail-body h2 { font-size: 12px; color: ${sectorColor}; }
        .neuron-detail-body h3 { font-size: 11px; }
        .neuron-detail-body p  { margin: 4px 0; line-height: 1.55; }
        .neuron-detail-body ul { margin: 4px 0 4px 16px; padding: 0; }
        .neuron-detail-body li { margin: 2px 0; line-height: 1.5; }
        .neuron-detail-body code {
          background: rgba(255,255,255,0.06); padding: 1px 4px; border-radius: 3px;
          font-size: 10px;
        }
        .neuron-detail-body pre {
          background: rgba(0,0,0,0.4); padding: 8px 10px; border-radius: 4px;
          overflow-x: auto; margin: 6px 0;
        }
        .neuron-detail-body pre code { background: none; font-size: 10px; }
        .neuron-detail-body blockquote {
          border-left: 2px solid ${sectorColor}; padding-left: 8px; margin: 6px 0;
          opacity: 0.8; font-style: italic;
        }
        .neuron-detail-body a { color: ${sectorColor}; text-decoration: none; }
        .neuron-detail-body a:hover { text-decoration: underline; }
        .neuron-detail-body .wikilink {
          color: ${sectorColor}; cursor: pointer;
          border-bottom: 1px dashed ${sectorColor}55;
        }
        .neuron-detail-body hr {
          border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 10px 0;
        }
      `}</style>

      {/* Header */}
      <div style={{
        padding: '14px 16px 12px',
        borderBottom: `1px solid ${sectorColor}33`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
      }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%',
          background: sectorColor,
          boxShadow: `0 0 12px ${sectorColor}`,
          marginTop: 4, flexShrink: 0,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 7, color: '#6B7280', letterSpacing: '0.15em',
            textTransform: 'uppercase', marginBottom: 4,
          }}>
            {isVault ? 'VAULT NEURON' : 'OBSERVATION NEURON'} · {sceneNode.category}
          </div>
          <div style={{
            fontSize: 14, fontWeight: 700, color: '#fff',
            wordBreak: 'break-word',
          }}>
            {sceneNode.label}
          </div>
          {isVault && source?.file && (
            <div style={{
              fontSize: 9, color: '#6B7280', marginTop: 4,
              fontFamily: '"JetBrains Mono", monospace',
            }}>
              {source.file}
            </div>
          )}
        </div>
        <button onClick={onClose} style={{
          background: 'transparent',
          border: `1px solid ${sectorColor}55`,
          color: sectorColor,
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10,
          padding: '3px 8px',
          borderRadius: 3,
          cursor: 'pointer',
          flexShrink: 0,
        }}>×</button>
      </div>

      {/* Metadata strip */}
      <div style={{
        padding: '8px 16px',
        background: 'rgba(255,255,255,0.02)',
        display: 'flex',
        gap: 14,
        fontSize: 8,
        color: '#9CA3AF',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}>
        {isVault && source && (
          <>
            <span>DIR <span style={{ color: '#E5E7EB' }}>{source.dir}</span></span>
            <span>LINKS <span style={{ color: '#E5E7EB' }}>{source.links?.length || 0}</span></span>
            <span>STATUS <span style={{ color: '#E5E7EB' }}>{source.status || '—'}</span></span>
            {source.updated && <span>UPDATED <span style={{ color: '#E5E7EB' }}>{source.updated}</span></span>}
          </>
        )}
        {!isVault && source && (
          <>
            <span>TYPE <span style={{ color: '#E5E7EB' }}>{source.type || '—'}</span></span>
            <span>PROJECT <span style={{ color: '#E5E7EB' }}>{source.project || '—'}</span></span>
            <span>ID <span style={{ color: '#E5E7EB' }}>#{source.id}</span></span>
          </>
        )}
      </div>

      {/* Body */}
      <div className="neuron-detail-body" style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px 16px',
        fontSize: 11,
        lineHeight: 1.6,
        color: '#D1D5DB',
      }}>
        {isVault ? (
          loading ? (
            <div style={{ opacity: 0.5 }}>Loading vault content...</div>
          ) : vaultContent?.content ? (
            <div dangerouslySetInnerHTML={{ __html: renderMarkdown(vaultContent.content) }} />
          ) : (
            <div style={{ opacity: 0.5 }}>(no content available)</div>
          )
        ) : (
          <div>
            {source?.narrative ? (
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>
                {source.narrative}
              </div>
            ) : source?.subtitle ? (
              <div style={{ whiteSpace: 'pre-wrap' }}>{source.subtitle}</div>
            ) : (
              <div style={{ opacity: 0.5 }}>(no narrative)</div>
            )}
            {source?.tags && source.tags.length > 0 && (
              <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {source.tags.map((t, i) => (
                  <span key={i} style={{
                    fontSize: 8,
                    padding: '2px 6px',
                    borderRadius: 3,
                    background: `${sectorColor}22`,
                    color: sectorColor,
                    letterSpacing: '0.05em',
                  }}>{t}</span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
