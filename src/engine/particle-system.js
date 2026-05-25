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
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = length(uv);

  float core = smoothstep(0.5, 0.0, d);
  float halo = exp(-d * d * 8.0) * v_glow * 0.5;
  float alpha = core + halo;

  if (alpha < 0.02) discard;

  float intensity = 0.7 + v_glow * 0.5;
  vec3 color = v_color * intensity;

  gl_FragColor = vec4(color * alpha, alpha);
}
`;

export class ParticleSystem {
  constructor(maxParticles = 8000) {
    this.maxParticles = maxParticles;
    this.count = 0;

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(maxParticles * 3);
    const colors = new Float32Array(maxParticles * 3);
    const glows = new Float32Array(maxParticles);
    const sizes = new Float32Array(maxParticles);

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('a_color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('a_glow', new THREE.BufferAttribute(glows, 1));
    geometry.setAttribute('a_size', new THREE.BufferAttribute(sizes, 1));

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

  updateGlow(index, value) {
    if (index >= this.count) return;
    this.geometry.attributes.a_glow.setX(index, value);
    this.geometry.attributes.a_glow.needsUpdate = true;
  }

  update(time) {
    this.material.uniforms.u_time.value = time;
  }

  getMesh() {
    return this.points;
  }
}
