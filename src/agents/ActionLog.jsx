import { useMemo } from 'react';

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

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 1) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/**
 * Live action log strip — last N broker feeds, newest at top.
 * Pure subscription to broker WS via the feeds prop.
 */
export default function ActionLog({ feeds }) {
  const recent = useMemo(() => {
    return [...feeds].slice(-12).reverse();
  }, [feeds]);

  return (
    <div style={{
      position: 'absolute',
      top: 56,
      right: 16,
      width: 340,
      maxHeight: 220,
      overflow: 'hidden',
      background: 'rgba(5, 5, 12, 0.78)',
      border: '1px solid rgba(255, 255, 255, 0.06)',
      borderRadius: 6,
      padding: '10px 12px',
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 9,
      color: '#9CA3AF',
      backdropFilter: 'blur(10px)',
      pointerEvents: 'none',
      zIndex: 30,
    }}>
      <div style={{
        fontSize: 8,
        textTransform: 'uppercase',
        letterSpacing: '0.18em',
        color: '#22d3ee',
        marginBottom: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <div style={{
          width: 5, height: 5, borderRadius: '50%',
          background: '#22d3ee',
          boxShadow: '0 0 4px #22d3ee',
          animation: 'pulse-dot 1.2s ease-in-out infinite',
        }} />
        NEURAL FEED — LIVE
      </div>

      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
      `}</style>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        maxHeight: 180,
        overflow: 'hidden',
      }}>
        {recent.length === 0 && (
          <div style={{ opacity: 0.4 }}>(waiting for feeds…)</div>
        )}
        {recent.map((f) => {
          const color = SECTOR_COLORS[f.targetSector] || '#666';
          return (
            <div key={f.id} style={{
              display: 'flex',
              gap: 6,
              alignItems: 'flex-start',
              padding: '2px 0',
              borderBottom: '1px solid rgba(255,255,255,0.025)',
            }}>
              <span style={{
                color: '#4B5563',
                fontSize: 8,
                width: 24,
                flexShrink: 0,
              }}>
                {f.timestamp ? timeAgo(f.timestamp) : ''}
              </span>
              <span style={{
                color,
                fontWeight: 700,
                fontSize: 8,
                letterSpacing: '0.05em',
                flexShrink: 0,
                width: 110,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {f.agentId}
              </span>
              <span style={{
                color: '#E5E7EB',
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 9,
              }}>
                {f.payloadSummary || '—'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
