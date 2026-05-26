/**
 * Anatomical procedural brain mesh.
 *
 * Builds a real brain shape from primitive geometries:
 *   - Two cerebral hemispheres (mirrored ellipsoids with deep longitudinal fissure)
 *   - Sulci/gyri folds from 3D simplex noise (domain-warped)
 *   - Cerebellum (smaller deformed ellipsoid at the posterior/inferior pole)
 *   - Brainstem (tapered capsule)
 *
 * Returns a merged BufferGeometry. The scene renders it as wireframe + faint fill.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// --- Simplex noise (Stefan Gustavson / Peter Eastman, public domain) -------
const F3 = 1.0 / 3.0;
const G3 = 1.0 / 6.0;
const grad3 = [
  [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
  [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
  [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1],
];
const PERM = new Uint8Array(512);
(function seed() {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = 1337;
  for (let i = 255; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();

function dot3(g, x, y, z) { return g[0]*x + g[1]*y + g[2]*z; }

function snoise3(xin, yin, zin) {
  const s = (xin + yin + zin) * F3;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const k = Math.floor(zin + s);
  const t = (i + j + k) * G3;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);
  const z0 = zin - (k - t);

  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0)      { i1=1; j1=0; k1=0; i2=1; j2=1; k2=0; }
    else if (x0 >= z0) { i1=1; j1=0; k1=0; i2=1; j2=0; k2=1; }
    else               { i1=0; j1=0; k1=1; i2=1; j2=0; k2=1; }
  } else {
    if (y0 < z0)       { i1=0; j1=0; k1=1; i2=0; j2=1; k2=1; }
    else if (x0 < z0)  { i1=0; j1=1; k1=0; i2=0; j2=1; k2=1; }
    else               { i1=0; j1=1; k1=0; i2=1; j2=1; k2=0; }
  }

  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2.0*G3, y2 = y0 - j2 + 2.0*G3, z2 = z0 - k2 + 2.0*G3;
  const x3 = x0 - 1.0 + 3.0*G3, y3 = y0 - 1.0 + 3.0*G3, z3 = z0 - 1.0 + 3.0*G3;

  const ii = i & 255, jj = j & 255, kk = k & 255;
  const gi0 = PERM[ii + PERM[jj + PERM[kk]]] % 12;
  const gi1 = PERM[ii + i1 + PERM[jj + j1 + PERM[kk + k1]]] % 12;
  const gi2 = PERM[ii + i2 + PERM[jj + j2 + PERM[kk + k2]]] % 12;
  const gi3 = PERM[ii + 1 + PERM[jj + 1 + PERM[kk + 1]]] % 12;

  let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
  let t0 = 0.6 - x0*x0 - y0*y0 - z0*z0;
  if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * dot3(grad3[gi0], x0, y0, z0); }
  let t1 = 0.6 - x1*x1 - y1*y1 - z1*z1;
  if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * dot3(grad3[gi1], x1, y1, z1); }
  let t2 = 0.6 - x2*x2 - y2*y2 - z2*z2;
  if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * dot3(grad3[gi2], x2, y2, z2); }
  let t3 = 0.6 - x3*x3 - y3*y3 - z3*z3;
  if (t3 >= 0) { t3 *= t3; n3 = t3 * t3 * dot3(grad3[gi3], x3, y3, z3); }

  return 32.0 * (n0 + n1 + n2 + n3);
}

function fbm(x, y, z, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * snoise3(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// --- Cerebral hemisphere ----------------------------------------------------
//
// A hemisphere is built from a SphereGeometry, deformed into an ellipsoid,
// then displaced by domain-warped fbm to carve sulci and raise gyri.
// `side` is +1 (right) or -1 (left); the deformation is mirrored across X=0.
function buildHemisphere(side, resolution = 56) {
  const geo = new THREE.SphereGeometry(1, resolution, resolution);
  const pos = geo.attributes.position;
  const count = pos.count;

  const widthScale = 0.75;
  const heightScale = 0.95;
  const depthScale = 1.05;
  const fissureGap = 0.06;   // X-shift away from midline to create longitudinal fissure
  const fissureDepth = 0.20; // how deeply midline-adjacent surface dips inward

  for (let i = 0; i < count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    // Ellipsoid scaling — wider than tall
    x *= widthScale;
    y *= heightScale;
    z *= depthScale;

    // Frontal lobe bulge (positive Z is forward)
    if (z > 0.2) y += (z - 0.2) * 0.08;

    // Flatten inferior surface so the brain sits on a base
    if (y < -0.55) y = -0.55 + (y + 0.55) * 0.45;

    // Temporal lobe widening (lower lateral)
    if (y < -0.05 && Math.abs(x) > 0.35) {
      const w = (1 - (y + 0.05) / -0.7) * 0.12;
      x += Math.sign(x || 1) * w;
    }

    // Mirror to chosen side, then push laterally to open the fissure
    x = Math.abs(x) * side;
    const lateralPush = Math.exp(-Math.abs(x) * 8) * fissureGap;
    x += lateralPush * side;

    // Domain-warped fbm for organic sulci/gyri
    const wx = x + fbm(x * 1.3, y * 1.3, z * 1.3, 2) * 0.6;
    const wy = y + fbm(x * 1.3 + 11.7, y * 1.3, z * 1.3, 2) * 0.6;
    const wz = z + fbm(x * 1.3, y * 1.3 + 23.5, z * 1.3, 2) * 0.6;

    const fine   = fbm(wx * 4.2, wy * 4.2, wz * 4.2, 4, 2.1, 0.55);   // primary gyri
    const fold   = fbm(wx * 8.5, wy * 8.5, wz * 8.5, 3, 2.0, 0.5);     // sulci ridges
    const micro  = fbm(wx * 17.0, wy * 17.0, wz * 17.0, 2, 2.0, 0.5); // surface roughness
    const displacement = fine * 0.085 + fold * 0.045 + micro * 0.018;

    // Sharpen sulci — ridge-style absolute-value trick
    const sulcus = -Math.abs(fold) * 0.06;

    // Compute outward normal (approximate from current pos relative to ellipsoid center)
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const nx = x / len, ny = y / len, nz = z / len;

    x += nx * (displacement + sulcus);
    y += ny * (displacement + sulcus);
    z += nz * (displacement + sulcus);

    // Carve fissure on the midline side: vertices near x=0 dip toward center
    const fissureFalloff = Math.exp(-Math.abs(x) * 14);
    x -= side * fissureFalloff * fissureDepth;

    pos.setXYZ(i, x, y, z);
  }

  geo.computeVertexNormals();
  return geo;
}

// --- Cerebellum -------------------------------------------------------------
function buildCerebellum() {
  const geo = new THREE.SphereGeometry(1, 40, 32);
  const pos = geo.attributes.position;
  const count = pos.count;

  for (let i = 0; i < count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    // Wide-flat ellipsoid
    x *= 0.48;
    y *= 0.26;
    z *= 0.38;

    // Tight horizontal striations (folia)
    const folia = Math.sin(y * 50.0 + fbm(x * 6, y * 6, z * 6, 2) * 3) * 0.012;

    // Soft surface bumps
    const surface = fbm(x * 12, y * 12, z * 12, 3) * 0.018;

    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const nx = x / len, ny = y / len, nz = z / len;

    x += nx * (folia + surface);
    y += ny * (folia + surface);
    z += nz * (folia + surface);

    pos.setXYZ(i, x, y, z);
  }

  geo.computeVertexNormals();
  geo.translate(0, -0.45, -0.55);
  return geo;
}

// --- Brainstem --------------------------------------------------------------
function buildBrainstem() {
  // Tapered capsule
  const geo = new THREE.CylinderGeometry(0.10, 0.07, 0.42, 18, 4, false);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // subtle sway forward (toward +Z)
    z += -y * 0.10;
    // micro surface noise
    const n = fbm(x * 8, y * 8, z * 8, 2) * 0.012;
    const len = Math.sqrt(x * x + z * z) || 1;
    x += (x / len) * n;
    z += (z / len) * n;
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  geo.translate(0, -0.65, -0.40);
  return geo;
}

// --- Public API -------------------------------------------------------------

export function generateAnatomicalBrain(resolution = 56) {
  const right = buildHemisphere(+1, resolution);
  const left  = buildHemisphere(-1, resolution);
  const cerebellum = buildCerebellum();
  const stem = buildBrainstem();

  const merged = mergeGeometries([right, left, cerebellum, stem], false);
  merged.computeVertexNormals();
  return merged;
}

// Back-compat shim: existing code calls generateHighPolyBrain — route to the new mesh.
export function generateHighPolyBrain(resolution = 56) {
  // resolution is a hint; the anatomical builder uses ~56 per hemisphere
  return generateAnatomicalBrain(Math.min(80, Math.max(32, resolution)));
}

export function generateLODs(highPoly) {
  // The merged anatomical mesh is already well under render budget (~12k tris).
  // LOD is no longer meaningful at viewing distances, so collapse to one level.
  return [{ geometry: highPoly, distance: 0 }];
}

// Normal-map baking is unused by the wireframe renderer but kept as a no-op
// for callers that still expect it.
export function bakeNormalMap(_highPoly, _size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(128,128,255)';
  ctx.fillRect(0, 0, 2, 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
