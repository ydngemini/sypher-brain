import { useMemo } from 'react';

const SECTOR_COLORS = {
  PREFRONTAL: '#ff3b30',
  CONCEPT_LAYER: '#ff9500',
  HIPPOCAMPUS: '#4cd964',
  CEREBELLUM: '#5ac8fa',
  CONTEXT_CORTEX: '#22d3ee',
  TEMPORAL: '#f59e0b',
  PARIETAL: '#34d399',
  OCCIPITAL: '#818cf8',
};

function timeSince(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function AgentCard({ agent }) {
  const sectorColor = SECTOR_COLORS[agent.lastSector] || '#666';
  const isActive = Date.now() - agent.lastActive < 60000;
  const pulseOpacity = isActive ? 1 : 0.4;

  return (
    <div data-agent-id={agent.id} style={{
      position: 'relative',
      width: 160,
      padding: '12px 14px',
      background: 'rgba(5, 5, 12, 0.92)',
      border: `1px solid ${isActive ? sectorColor + '60' : 'rgba(50, 50, 70, 0.3)'}`,
      borderRadius: 10,
      backdropFilter: 'blur(12px)',
      boxShadow: isActive ? `0 0 16px ${sectorColor}22, 0 4px 16px rgba(0,0,0,0.5)` : '0 2px 8px rgba(0,0,0,0.3)',
      transition: 'all 0.4s ease',
      opacity: pulseOpacity,
    }}>
      {/* Status dot */}
      <div style={{
        position: 'absolute',
        top: 8,
        right: 8,
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: isActive ? '#4cd964' : '#4B5563',
        boxShadow: isActive ? '0 0 6px #4cd964' : 'none',
      }} />

      <div style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
        fontWeight: 700,
        color: '#E5E7EB',
        marginBottom: 4,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: 120,
      }}>
        {agent.id}
      </div>

      <div style={{
        fontSize: 9,
        color: sectorColor,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 6,
      }}>
        {agent.lastSector || '—'}
      </div>

      {/* Intensity bar */}
      <div style={{
        width: '100%',
        height: 3,
        background: 'rgba(50, 50, 70, 0.4)',
        borderRadius: 2,
        marginBottom: 6,
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${(agent.intensity || 0) * 100}%`,
          height: '100%',
          background: `linear-gradient(90deg, ${sectorColor}88, ${sectorColor})`,
          borderRadius: 2,
          transition: 'width 0.5s ease',
        }} />
      </div>

      <div style={{
        fontSize: 9,
        color: '#6B7280',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {agent.lastSummary || 'idle'}
      </div>

      <div style={{
        fontSize: 8,
        color: '#4B5563',
        marginTop: 4,
        display: 'flex',
        justifyContent: 'space-between',
      }}>
        <span>{agent.feeds || 0} feeds</span>
        <span>{agent.lastActive ? timeSince(agent.lastActive) : '—'}</span>
      </div>
    </div>
  );
}

export default function AgentGrid({ agents, connected }) {
  const sortedAgents = useMemo(() =>
    [...agents].sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0)),
    [agents]
  );

  return (
    <div style={{
      position: 'absolute',
      top: 56,
      left: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      maxHeight: 'calc(100vh - 140px)',
      overflowY: 'auto',
      overflowX: 'hidden',
      scrollbarWidth: 'none',
    }}>
      {/* Header */}
      <div style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 9,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
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
        {connected ? 'AGENTS ONLINE' : 'BROKER OFFLINE'}
      </div>

      {sortedAgents.length === 0 && (
        <div style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10,
          color: '#4B5563',
          padding: '8px 4px',
        }}>
          No agents connected
        </div>
      )}

      {sortedAgents.map(agent => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  );
}
