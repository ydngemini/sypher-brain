/**
 * PBR materials for the brain visualization.
 * Uses MeshPhysicalMaterial for subsurface scattering look.
 */
import * as THREE from 'three';

export function createBrainMaterial(normalMap) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x0a0418),
    emissive: new THREE.Color(0x0a0515),
    emissiveIntensity: 0.15,
    metalness: 0.0,
    roughness: 0.9,
    transmission: 0.85,
    thickness: 0.5,
    ior: 1.1,
    transparent: true,
    opacity: 0.08,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.4, 0.4),
    clearcoat: 0.1,
    clearcoatRoughness: 0.8,
    side: THREE.FrontSide,
    depthWrite: false,
  });
}

export function createActiveBrainMaterial(normalMap) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x2d1b69),
    emissive: new THREE.Color(0x4a2080),
    emissiveIntensity: 0.6,
    metalness: 0.05,
    roughness: 0.6,
    transmission: 0.3,
    thickness: 1.2,
    ior: 1.4,
    transparent: true,
    opacity: 0.4,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(1.0, 1.0),
    clearcoat: 0.5,
    clearcoatRoughness: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

export function createNodeMaterial(color, glow) {
  return new THREE.PointsMaterial({
    color: new THREE.Color(color),
    size: 0.02 + glow * 0.03,
    transparent: true,
    opacity: 0.6 + glow * 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
}

export function createEdgeMaterial(activity) {
  return new THREE.LineBasicMaterial({
    color: new THREE.Color(0x4a3080 + Math.floor(activity * 0x302060)),
    transparent: true,
    opacity: 0.2 + activity * 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}
