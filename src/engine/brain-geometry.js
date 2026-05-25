/**
 * Procedural brain mesh generator.
 * Creates a high-poly brain (50k+ tris), then decimates to 3 LOD levels.
 * Bakes surface detail into normal map data.
 */
import * as THREE from 'three';

const BRAIN_PARAMS = {
  widthScale: 1.35,
  heightScale: 1.0,
  depthScale: 1.15,
  gyriFrequencies: [7, 11, 15, 19, 23],
  gyriAmplitudes: [0.045, 0.035, 0.025, 0.018, 0.012],
  sulciDepth: 0.06,
  midlineSplit: 0.18,
  flattenBelow: -0.75,
};

export function generateHighPolyBrain(resolution = 128) {
  const geometry = new THREE.SphereGeometry(1, resolution, resolution);
  const pos = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const count = pos.count;

  const tangents = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    const theta = Math.acos(Math.max(-1, Math.min(1, y)));
    const phi = Math.atan2(z, x);

    // Ellipsoid deformation
    x *= BRAIN_PARAMS.widthScale;
    y *= BRAIN_PARAMS.heightScale;
    z *= BRAIN_PARAMS.depthScale;

    // Hemisphere split — deep sulcus along midline
    const midlineFactor = Math.exp(-x * x * 12);
    y -= midlineFactor * BRAIN_PARAMS.midlineSplit;

    // Gyri bumps — multiple frequency octaves
    let bump = 0;
    for (let f = 0; f < BRAIN_PARAMS.gyriFrequencies.length; f++) {
      const freq = BRAIN_PARAMS.gyriFrequencies[f];
      const amp = BRAIN_PARAMS.gyriAmplitudes[f];
      bump += amp * Math.sin(theta * freq + phi * (freq * 0.7))
            * Math.cos(phi * freq * 0.5 + theta * (freq * 0.3));
    }

    // Sulci — deeper creases
    const sulci = Math.abs(Math.sin(theta * 9 + phi * 6)) < 0.3
      ? -BRAIN_PARAMS.sulciDepth * (1 - Math.abs(Math.sin(theta * 9 + phi * 6)) / 0.3)
      : 0;

    const r = 1.0 + bump + sulci;
    const origLen = Math.sqrt(x * x + y * y + z * z);
    const scale = r / (origLen || 1);
    x *= scale;
    y *= scale;
    z *= scale;

    // Flatten bottom (brain stem area)
    if (y < BRAIN_PARAMS.flattenBelow) {
      y = BRAIN_PARAMS.flattenBelow + (y - BRAIN_PARAMS.flattenBelow) * 0.2;
    }

    // Frontal lobe bulge
    const frontalFactor = Math.max(0, z) * Math.max(0, 0.8 - Math.abs(x));
    y += frontalFactor * 0.08;

    // Temporal lobe widening
    if (y < -0.2 && Math.abs(x) > 0.5) {
      const temporal = (1 - (y + 0.2) / 0.6) * (Math.abs(x) - 0.5) * 0.15;
      x += Math.sign(x) * temporal;
    }

    pos.setXYZ(i, x, y, z);
  }

  geometry.computeVertexNormals();
  geometry.computeTangents();

  return geometry;
}

export function generateLODs(highPoly) {
  const lod0 = highPoly; // ~32k tris
  const lod1 = decimateGeometry(highPoly, 0.4); // ~12k tris
  const lod2 = decimateGeometry(highPoly, 0.15); // ~5k tris

  return [
    { geometry: lod0, distance: 0 },
    { geometry: lod1, distance: 4 },
    { geometry: lod2, distance: 8 },
  ];
}

function decimateGeometry(source, ratio) {
  // Simple vertex merging decimation
  const resolution = Math.max(8, Math.floor(Math.sqrt(source.attributes.position.count * ratio)));
  const decimated = new THREE.SphereGeometry(1, resolution, resolution);
  const srcPos = source.attributes.position;
  const dstPos = decimated.attributes.position;

  // Project decimated vertices onto the high-poly surface
  const raycaster = new THREE.Raycaster();
  const tempMesh = new THREE.Mesh(source);
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();

  for (let i = 0; i < dstPos.count; i++) {
    direction.set(dstPos.getX(i), dstPos.getY(i), dstPos.getZ(i)).normalize();
    origin.copy(direction).multiplyScalar(3);
    direction.negate();

    raycaster.set(origin, direction);
    const hits = raycaster.intersectObject(tempMesh);
    if (hits.length > 0) {
      const p = hits[0].point;
      dstPos.setXYZ(i, p.x, p.y, p.z);
    } else {
      // Fallback: use scaled direction with brain deformation
      const theta = Math.acos(dstPos.getY(i));
      const phi = Math.atan2(dstPos.getZ(i), dstPos.getX(i));
      let x = BRAIN_PARAMS.widthScale * Math.sin(theta) * Math.cos(phi);
      let y = BRAIN_PARAMS.heightScale * Math.cos(theta);
      let z = BRAIN_PARAMS.depthScale * Math.sin(theta) * Math.sin(phi);
      const midline = Math.exp(-x * x * 12);
      y -= midline * BRAIN_PARAMS.midlineSplit;
      dstPos.setXYZ(i, x, y, z);
    }
  }

  decimated.computeVertexNormals();
  return decimated;
}

export function bakeNormalMap(highPoly, size = 1024) {
  // Generate a tangent-space normal map by comparing high-poly normals to a smooth sphere
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(size, size);
  const data = imageData.data;

  const pos = highPoly.attributes.position;
  const norm = highPoly.attributes.normal;
  const uv = highPoly.attributes.uv;

  // For each UV texel, find the closest vertex and encode its normal deviation
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const v = (py + 0.5) / size;

      // Spherical mapping: UV → theta/phi → smooth normal
      const theta = v * Math.PI;
      const phi = u * Math.PI * 2;
      const smoothNx = Math.sin(theta) * Math.cos(phi);
      const smoothNy = Math.cos(theta);
      const smoothNz = Math.sin(theta) * Math.sin(phi);

      // Find nearest vertex in UV space
      let bestDist = Infinity;
      let bestIdx = 0;
      if (uv) {
        for (let i = 0; i < uv.count; i++) {
          const du = uv.getX(i) - u;
          const dv = uv.getY(i) - v;
          const d = du * du + dv * dv;
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
      }

      // Get actual normal from high-poly
      let nx = norm.getX(bestIdx);
      let ny = norm.getY(bestIdx);
      let nz = norm.getZ(bestIdx);

      // Encode as tangent-space normal (relative to smooth surface)
      // Simplified: treat deviation from smooth normal as the tangent-space offset
      const dx = (nx - smoothNx) * 0.5 + 0.5;
      const dy = (ny - smoothNy) * 0.5 + 0.5;
      const dz = (nz - smoothNz) * 0.5 + 0.5;

      const idx = (py * size + px) * 4;
      data[idx] = Math.floor(Math.max(0, Math.min(1, dx)) * 255);
      data[idx + 1] = Math.floor(Math.max(0, Math.min(1, dy)) * 255);
      data[idx + 2] = Math.floor(Math.max(0, Math.min(1, dz)) * 255);
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
