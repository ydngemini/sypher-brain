/**
 * Brain region definitions and position mapping.
 */

export const BRAIN_REGIONS = [
  { name: 'PREFRONTAL', center: [0, 0.4, 0.7], radius: 0.45, color: [1.0, 0.23, 0.19] },
  { name: 'CONCEPT LAYER', center: [-0.3, 0.0, 0.2], radius: 0.5, color: [1.0, 0.58, 0.0] },
  { name: 'SENSORY CORTEX', center: [0.7, 0.1, 0.1], radius: 0.45, color: [0.0, 0.9, 0.95] },
  { name: 'TEMPORAL', center: [-0.7, -0.3, -0.1], radius: 0.4, color: [1.0, 0.6, 0.1] },
  { name: 'PARIETAL', center: [0, 0.6, -0.2], radius: 0.4, color: [0.2, 0.8, 0.4] },
  { name: 'OCCIPITAL', center: [0, -0.1, -0.7], radius: 0.4, color: [0.5, 0.55, 0.97] },
  { name: 'HIPPOCAMPUS', center: [-0.5, -0.5, 0.3], radius: 0.35, color: [0.30, 0.85, 0.39] },
  { name: 'CEREBELLUM', center: [-0.8, 0.1, 0.0], radius: 0.4, color: [0.9, 0.2, 0.7] },
];

const CATEGORY_TO_REGION = {
  project: 0,
  concept: 1,
  discovery: 4,
  decision: 0,
  session: 6,
  entity: 2,
  sensory: 2,
  synthesis: 5,
  default: 3,
};

function pseudoRandom(seed) {
  let x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function mapToBrainPosition(index, total, category = 'default', seed = 42) {
  const regionIdx = CATEGORY_TO_REGION[category] ?? CATEGORY_TO_REGION.default;
  const region = BRAIN_REGIONS[regionIdx];

  const golden = (1 + Math.sqrt(5)) / 2;
  const i = index + 0.5;
  const theta = Math.acos(1 - 2 * i / Math.max(total, 1));
  const phi = 2 * Math.PI * i * golden;
  const r = 0.1 + pseudoRandom(index * 127 + seed) * region.radius * 0.4;

  const x = region.center[0] + r * Math.sin(theta) * Math.cos(phi);
  const y = region.center[1] + r * Math.cos(theta);
  const z = region.center[2] + r * Math.sin(theta) * Math.sin(phi);

  return [x, y, z];
}
