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

const INFLIGHT_WINDOW_MS = 4500; // walker journey takes ~3-5s; mark agent in-flight that long

function timeSince(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * Per-agent intensity sparkline. Reads real feeds[] (last 50 from broker),
 * filters to this agent, takes most recent 8 intensities, draws an SVG polyline.
 */
function Sparkline({ feeds, agentId, color }) {
  const data = useMemo(() => {
    const samples = feeds
      .filter(f => f.agentId === agentId)
      .slice(-8)
      .map(f => f.intensity ?? 0);
    return samples;
  }, [feeds, agentId]);

  if (data.length === 0) {
    return <div style={{ height: 14 }} />;
  }

  const W = 80;
  const H = 14;
  const padX = 1;
  const padY = 2;
  const stepX = data.length > 1 ? (W - padX * 2) / (data.length - 1) : 0;
  const points = data
    .map((v, i) => `${padX + i * stepX},${H - padY - (H - padY * 2) * Math.max(0, Math.min(1, v))}`)
    .join(' ');

  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1}
        strokeLinejoin="round"
        opacity={0.85}
      />
      {data.map((v, i) => (
        <circle
          key={i}
          cx={padX + i * stepX}
          cy={H - padY - (H - padY * 2) * Math.max(0, Math.min(1, v))}
          r={i === data.length - 1 ? 1.5 : 0.8}
          fill={color}
          opacity={i === data.length - 1 ? 1 : 0.5}
        />
      ))}
    </svg>
  );
}

function HexCard({ agent, feeds, lastPayload }) {
  const sectorColor = SECTOR_COLORS[agent.lastSector] || '#666';
  const sinceActive = agent.lastActive ? Date.now() - agent.lastActive : Infinity;
  const isActive = sinceActive < 60000;
  const isInFlight = sinceActive < INFLIGHT_WINDOW_MS;
  const opacity = isActive ? 1 : 0.35;

  return (
    <div
      data-agent-id={agent.id}
      style={{
        position: 'relative',
        opacity,
        transition: 'opacity 0.4s ease',
      }}
    >
      {/* Hex glow border — strong while in flight, mild while just active */}
      <div style={{
        position: 'absolute',
        inset: -2,
        clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
        background: isInFlight ? sectorColor : (isActive ? sectorColor : 'transparent'),
        opacity: isInFlight ? 0.55 : (isActive ? 0.22 : 0),
        filter: isInFlight ? `blur(6px) drop-shadow(0 0 14px ${sectorColor})`
                          : (isActive ? `blur(3px)` : 'none'),
        transition: 'opacity 0.4s ease, filter 0.4s ease',
      }} />

      {/* In-flight pulse ring */}
      {isInFlight && (
        <div style={{
          position: 'absolute',
          inset: -8,
          clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
          border: `1px solid ${sectorColor}`,
          animation: 'pulse-ring 1.2s ease-out infinite',
          pointerEvents: 'none',
        }} />
      )}

      <div style={{
        width: 132,
        clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
        background: 'rgba(5, 5, 12, 0.94)',
        padding: '22px 12px 18px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
      }}>
        {/* Status dot — green active / orange in-flight / grey idle */}
        <div style={{
          width: 5, height: 5, borderRadius: '50%',
          background: isInFlight ? '#fbbf24' : (isActive ? '#4cd964' : '#4B5563'),
          boxShadow: isInFlight ? '0 0 6px #fbbf24'
                   : (isActive ? '0 0 5px #4cd964' : 'none'),
        }} />

        <div style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 8,
          fontWeight: 700,
          color: '#E5E7EB',
          textAlign: 'center',
          maxWidth: 110,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{agent.id}</div>

        <div style={{
          fontSize: 6.5,
          color: sectorColor,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
        }}>{agent.lastSector || '—'}</div>

        {/* Sparkline of recent intensities (real broker data) */}
        <Sparkline feeds={feeds} agentId={agent.id} color={sectorColor} />

        {/* Current/last payload text — real, from broker */}
        {lastPayload && (
          <div style={{
            fontSize: 6.5,
            color: '#9CA3AF',
            fontFamily: '"JetBrains Mono", monospace',
            textAlign: 'center',
            maxWidth: 100,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            opacity: 0.8,
            fontStyle: 'italic',
          }}>
            {lastPayload}
          </div>
        )}

        <div style={{
          fontSize: 6.5,
          color: '#6B7280',
          fontFamily: '"JetBrains Mono", monospace',
          display: 'flex',
          gap: 8,
        }}>
          <span>{agent.feeds || 0}f</span>
          <span>{agent.lastActive ? `${timeSince(agent.lastActive)}` : '—'}</span>
        </div>
      </div>
    </div>
  );
}

export default function AgentGrid({ agents, feeds, connected }) {
  // Sort: in-flight first, then by recency
  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      const aFlight = (Date.now() - (a.lastActive || 0)) < INFLIGHT_WINDOW_MS ? 1 : 0;
      const bFlight = (Date.now() - (b.lastActive || 0)) < INFLIGHT_WINDOW_MS ? 1 : 0;
      if (aFlight !== bFlight) return bFlight - aFlight;
      return (b.lastActive || 0) - (a.lastActive || 0);
    });
  }, [agents]);

  // Per-agent last payload
  const lastPayloadByAgent = useMemo(() => {
    const out = new Map();
    for (let i = feeds.length - 1; i >= 0; i--) {
      const f = feeds[i];
      if (!out.has(f.agentId) && f.payloadSummary) {
        out.set(f.agentId, f.payloadSummary);
      }
    }
    return out;
  }, [feeds]);

  const workingCount = agents.filter(a => Date.now() - (a.lastActive || 0) < 60000).length;
  const inFlightCount = agents.filter(a => Date.now() - (a.lastActive || 0) < INFLIGHT_WINDOW_MS).length;
  const totalSynapses = agents.reduce((acc, a) => acc + (a.feeds || 0), 0);

  return (
    <div style={{
      position: 'absolute',
      top: 56,
      left: 14,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      maxHeight: 'calc(100vh - 200px)',
      overflowY: 'auto',
      overflowX: 'hidden',
      scrollbarWidth: 'none',
      paddingRight: 4,
    }}>
      <style>{`
        @keyframes pulse-ring {
          0%   { opacity: 0.7; transform: scale(0.85); }
          100% { opacity: 0;   transform: scale(1.12); }
        }
      `}</style>

      <div style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 8,
        textTransform: 'uppercase',
        letterSpacing: '0.18em',
        color: connected ? '#4cd964' : '#ef4444',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 4px',
      }}>
        <div style={{
          width: 5, height: 5, borderRadius: '50%',
          background: connected ? '#4cd964' : '#ef4444',
          boxShadow: connected ? '0 0 4px #4cd964' : 'none',
        }} />
        AGENT OFFICE
      </div>

      <div style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 7,
        color: '#6B7280',
        letterSpacing: '0.1em',
        display: 'flex',
        gap: 10,
        padding: '0 4px',
        flexWrap: 'wrap',
      }}>
        <span>WORKING <span style={{ color: '#4cd964' }}>{workingCount}</span></span>
        <span>WALKING <span style={{ color: '#fbbf24' }}>{inFlightCount}</span></span>
        <span>FEEDS <span style={{ color: '#E5E7EB' }}>{totalSynapses}</span></span>
      </div>

      {sortedAgents.length === 0 && (
        <div style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 9,
          color: '#4B5563',
          padding: '8px 4px',
        }}>
          No agents connected
        </div>
      )}

      {sortedAgents.map(agent => (
        <HexCard
          key={agent.id}
          agent={agent}
          feeds={feeds}
          lastPayload={lastPayloadByAgent.get(agent.id)}
        />
      ))}
    </div>
  );
}
