export const NODE_COLORS = {
  project: '#4A9EFF',
  concept: '#A78BFA',
  discovery: '#34D399',
  decision: '#F59E0B',
  session: '#22D3EE',
  entity: '#F472B6',
  synthesis: '#818CF8',
  stale: '#4B5563',
  default: '#9CA3AF'
};

export const EDGE_COLOR = '#374151';
export const EDGE_ACTIVE_COLOR = '#6B7280';

export function getNodeColor(type, isStale) {
  if (isStale) return NODE_COLORS.stale;
  return NODE_COLORS[type] || NODE_COLORS.default;
}

export function getGlowIntensity(updatedEpoch) {
  const age = (Date.now() - updatedEpoch) / 1000;
  if (age < 60) return 1.0;
  if (age < 3600) return 1.0 - (age / 3600) * 0.5;
  if (age < 86400) return 0.3;
  return 0.05;
}
