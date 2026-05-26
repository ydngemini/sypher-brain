/**
 * GPU particle system for neural nodes.
 * Uses instanced rendering + custom shader for per-particle glow/pulse.
 */
import * as THREE from 'three';

const PARTICLE_VERTEX = `
uniform float u_time;
attribute float a_glow;
attribute vec3 a_color;
attribute float a_size;

varying vec3 v_color;
varying float v_glow;

void main() {
  v_color = a_color;
  v_glow = a_glow;

  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);

  float pulse = 1.0 + 0.15 * sin(u_time * 2.5 + a_glow * 6.28) * a_glow;
  gl_PointSize = a_size * pulse * (80.0 / -mvPos.z);
  gl_Position = projectionMatrix * mvPos;
}
`;

const PARTICLE_FRAGMENT = `
uniform float u_time;
varying vec3 v_color;
varying float v_glow;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);

  // Horizontal dash shape — width varies per particle for organic look
  float dashWidth = 0.25 + fract(v_color.r * 12.345) * 0.2;
  float dashHeight = 0.035 + v_glow * 0.015;

  if (abs(coord.y) > dashHeight || abs(coord.x) > dashWidth) discard;

  // Soft edges
  float edgeX = smoothstep(dashWidth, dashWidth - 0.06, abs(coord.x));
  float edgeY = smoothstep(dashHeight, dashHeight - 0.01, abs(coord.y));
  float alpha = edgeX * edgeY;

  // Glow halo around the dash
  float halo = exp(-(coord.x * coord.x * 4.0 + coord.y * coord.y * 60.0)) * v_glow * 0.4;
  alpha = max(alpha, halo);

  if (alpha < 0.02) discard;

  float intensity = 0.7 + v_glow * 0.5;
  vec3 color = v_color * intensity;

  gl_FragColor = vec4(color * alpha, alpha);
}
`;

export class ParticleSystem {
  constructor(maxParticles = 1_000_000) {
    this.maxParticles = maxParticles;
    this.count = 0;

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(maxParticles * 3);
    const colors = new Float32Array(maxParticles * 3);
    const glows = new Float32Array(maxParticles);
    const sizes = new Float32Array(maxParticles);

    const posAttr  = new THREE.BufferAttribute(positions, 3);
    const colAttr  = new THREE.BufferAttribute(colors, 3);
    const glowAttr = new THREE.BufferAttribute(glows, 1);
    const sizeAttr = new THREE.BufferAttribute(sizes, 1);
    // STATIC_DRAW would be wrong — we mutate frequently
    posAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    glowAttr.setUsage(THREE.DynamicDrawUsage);
    sizeAttr.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('a_color', colAttr);
    geometry.setAttribute('a_glow', glowAttr);
    geometry.setAttribute('a_size', sizeAttr);

    const material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      uniforms: {
        u_time: { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.points = new THREE.Points(geometry, material);
    this.geometry = geometry;
    this.material = material;
  }

  setParticles(particles) {
    const pos = this.geometry.attributes.position;
    const col = this.geometry.attributes.a_color;
    const glow = this.geometry.attributes.a_glow;
    const size = this.geometry.attributes.a_size;

    this.count = Math.min(particles.length, this.maxParticles);

    for (let i = 0; i < this.count; i++) {
      const p = particles[i];
      pos.setXYZ(i, p.x, p.y, p.z);
      col.setXYZ(i, p.r, p.g, p.b);
      glow.setX(i, p.glow);
      size.setX(i, p.size);
    }

    pos.needsUpdate = true;
    col.needsUpdate = true;
    glow.needsUpdate = true;
    size.needsUpdate = true;
    this.geometry.setDrawRange(0, this.count);
  }

  // Append a batch of new particles. Only the changed portion of each buffer
  // is uploaded to the GPU — critical for performance at 1M cap.
  // Returns the start index for the appended block (caller may want it for
  // later updateGlow / updateSize calls).
  appendParticles(particles) {
    if (this.count >= this.maxParticles) return -1;
    const pos = this.geometry.attributes.position;
    const col = this.geometry.attributes.a_color;
    const glow = this.geometry.attributes.a_glow;
    const size = this.geometry.attributes.a_size;

    const startIndex = this.count;
    const limit = Math.min(particles.length, this.maxParticles - startIndex);

    for (let i = 0; i < limit; i++) {
      const p = particles[i];
      const idx = startIndex + i;
      pos.setXYZ(idx, p.x, p.y, p.z);
      col.setXYZ(idx, p.r, p.g, p.b);
      glow.setX(idx, p.glow);
      size.setX(idx, p.size);
    }

    this.count += limit;
    // Mark only the appended range dirty (massive perf win at 1M cap)
    if (pos.addUpdateRange) {
      pos.addUpdateRange(startIndex * 3, limit * 3);
      col.addUpdateRange(startIndex * 3, limit * 3);
      glow.addUpdateRange(startIndex, limit);
      size.addUpdateRange(startIndex, limit);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    glow.needsUpdate = true;
    size.needsUpdate = true;
    this.geometry.setDrawRange(0, this.count);
    return startIndex;
  }

  updateGlow(index, value) {
    if (index >= this.count) return;
    const a = this.geometry.attributes.a_glow;
    a.setX(index, value);
    if (a.addUpdateRange) a.addUpdateRange(index, 1);
    a.needsUpdate = true;
  }

  updateSize(index, value) {
    if (index >= this.count) return;
    const a = this.geometry.attributes.a_size;
    a.setX(index, value);
    if (a.addUpdateRange) a.addUpdateRange(index, 1);
    a.needsUpdate = true;
  }

  update(time) {
    this.material.uniforms.u_time.value = time;
  }

  getMesh() {
    return this.points;
  }
}
