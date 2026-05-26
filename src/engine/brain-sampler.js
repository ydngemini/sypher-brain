/**
 * Brain-volume sampler.
 *
 * Returns positions guaranteed to fall INSIDE the anatomical brain mesh
 * (two cerebral hemispheres + cerebellum + brainstem). Uses rejection
 * sampling against the same parametric volumes used by brain-geometry.js
 * so neurons sit visibly within the wireframe shell.
 *
 * Coordinate space matches BrainScene before brainGroup.position.y offset
 * is applied — so callers should NOT pre-shift; the brainGroup transform
 * handles the y=0.25 lift.
 */

// Brain geometry parameters — kept in sync with brain-geometry.js
const HEMI = { w: 0.75, h: 0.95, d: 1.05, fissureGap: 0.06 };
const CRBL = { w: 0.48, h: 0.26, d: 0.38, ox: 0, oy: -0.45, oz: -0.55 };
const STEM = { rTop: 0.10, rBot: 0.07, height: 0.42, ox: 0, oy: -0.65, oz: -0.40 };

// Mass-weighted region selection. Roughly proportional to volume of each part.
//   hemisphere right: ~46%, hemisphere left: ~46%, cerebellum: ~7%, brainstem: ~1%
function pickRegion(rng) {
  const r = rng();
  if (r < 0.46) return 'hemiR';
  if (r < 0.92) return 'hemiL';
  if (r < 0.99) return 'cerebellum';
  return 'brainstem';
}

function sampleSolidEllipsoid(rng, sx, sy, sz) {
  // Reject points outside the unit sphere, then scale.
  for (let i = 0; i < 16; i++) {
    const x = rng() * 2 - 1;
    const y = rng() * 2 - 1;
    const z = rng() * 2 - 1;
    if (x * x + y * y + z * z <= 1) {
      return [x * sx, y * sy, z * sz];
    }
  }
  // Fallback after 16 rejections (vanishingly rare)
  return [0, 0, 0];
}

function sampleHemisphere(side, rng) {
  let [x, y, z] = sampleSolidEllipsoid(rng, HEMI.w, HEMI.h, HEMI.d);
  // Mirror onto the chosen side, push out by fissureGap so the midline is hollow
  x = Math.abs(x) * side;
  const lateralPush = Math.exp(-Math.abs(x) * 8) * HEMI.fissureGap;
  x += lateralPush * side;
  // Frontal lobe bulge bias (mild)
  if (z > 0.2) y += (z - 0.2) * 0.08;
  // Inferior flatten (so points don't pool below the hemisphere)
  if (y < -0.55) y = -0.55 + (y + 0.55) * 0.45;
  // Bring points slightly inward from the wireframe surface so they read as
  // "inside" rather than dotted on it.
  const r2 = x * x / (HEMI.w * HEMI.w) + y * y / (HEMI.h * HEMI.h) + z * z / (HEMI.d * HEMI.d);
  if (r2 > 0.92) {
    const shrink = Math.sqrt(0.92 / r2);
    x *= shrink; y *= shrink; z *= shrink;
  }
  return [x, y, z];
}

function sampleCerebellum(rng) {
  const [lx, ly, lz] = sampleSolidEllipsoid(rng, CRBL.w * 0.95, CRBL.h * 0.95, CRBL.d * 0.95);
  return [lx + CRBL.ox, ly + CRBL.oy, lz + CRBL.oz];
}

function sampleBrainstem(rng) {
  // Cylinder + linear taper
  const y = (rng() - 0.5) * STEM.height;
  const tapeT = (y + STEM.height / 2) / STEM.height; // 0 at bottom, 1 at top
  const rMax = STEM.rBot + (STEM.rTop - STEM.rBot) * tapeT;
  const r = Math.sqrt(rng()) * rMax * 0.9;
  const theta = rng() * Math.PI * 2;
  const x = r * Math.cos(theta);
  const z = r * Math.sin(theta);
  // Match the slight forward sway in brain-geometry
  const zSway = -y * 0.10;
  return [x + STEM.ox, y + STEM.oy, z + STEM.oz + zSway];
}

export function sampleInBrain(rng = Math.random) {
  const region = pickRegion(rng);
  switch (region) {
    case 'hemiR':      return sampleHemisphere(+1, rng);
    case 'hemiL':      return sampleHemisphere(-1, rng);
    case 'cerebellum': return sampleCerebellum(rng);
    case 'brainstem':  return sampleBrainstem(rng);
  }
  return [0, 0, 0];
}

// Sample a position with a sector bias — used when a neuron belongs to a
// brain sector and should appear in that region's volume, not anywhere.
const SECTOR_REGION = {
  PREFRONTAL:     { region: 'hemiR', biasZ: +0.55, biasY: +0.30 },
  CONCEPT_LAYER:  { region: 'hemiL', biasZ: +0.10, biasY: -0.05 },
  SENSORY_CORTEX: { region: 'hemiR', biasZ: +0.05, biasY: +0.05 },
  TEMPORAL:       { region: 'hemiL', biasZ: -0.10, biasY: -0.30 },
  PARIETAL:       { region: 'hemiR', biasZ: -0.20, biasY: +0.45 },
  OCCIPITAL:      { region: 'hemiL', biasZ: -0.55, biasY: -0.10 },
  HIPPOCAMPUS:    { region: 'hemiL', biasZ: +0.20, biasY: -0.40 },
  CEREBELLUM:     { region: 'cerebellum' },
  BRAINSTEM:      { region: 'brainstem' },
};

export function sampleInSector(sector, rng = Math.random) {
  const cfg = SECTOR_REGION[sector];
  if (!cfg) return sampleInBrain(rng);

  let p;
  switch (cfg.region) {
    case 'hemiR':      p = sampleHemisphere(+1, rng); break;
    case 'hemiL':      p = sampleHemisphere(-1, rng); break;
    case 'cerebellum': p = sampleCerebellum(rng); break;
    case 'brainstem':  p = sampleBrainstem(rng); break;
    default:           p = sampleInBrain(rng);
  }
  // Pull toward the sector's nominal anchor by ~40% — a soft bias, not a hard
  // cluster, so neighborhoods remain organic.
  if (cfg.biasZ !== undefined) p[2] = p[2] * 0.6 + cfg.biasZ * 0.4;
  if (cfg.biasY !== undefined) p[1] = p[1] * 0.6 + cfg.biasY * 0.4;
  return p;
}
