import * as THREE from 'three';

const MAX_INSTANCES = 512;

const INSTANCED_VERTEX = `
uniform float uGlobalTime;
uniform vec3 uTargetSectorCenter;

attribute vec3 aOriginInstance;
attribute float aParticleSeed;
attribute float aActivationTime;
attribute float aIntensity;
attribute vec3 aColor;

varying vec3 vColorGlow;
varying float vLifeCycleAlpha;

void main() {
    float lifeFactor = (uGlobalTime - aActivationTime) * 0.75;
    float clampLife = clamp(lifeFactor, 0.0, 1.0);

    vec3 trajectory = mix(aOriginInstance, uTargetSectorCenter, clampLife);

    trajectory.x += sin(lifeFactor * 5.0 + aParticleSeed) * 0.15 * (1.0 - clampLife);
    trajectory.y += cos(lifeFactor * 4.0 + aParticleSeed) * 0.15 * (1.0 - clampLife);
    trajectory.z += sin(lifeFactor * 3.0 + aParticleSeed * 2.0) * 0.08 * (1.0 - clampLife);

    vLifeCycleAlpha = sin(clampLife * 3.14159265) * aIntensity;
    vColorGlow = aColor * (0.8 + aIntensity * 0.5);

    vec4 mvPosition = modelViewMatrix * vec4(trajectory, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = (6.0 + sin(uGlobalTime + aParticleSeed) * 2.0) * (1.0 / -mvPosition.z);
}
`;

const INSTANCED_FRAGMENT = `
varying vec3 vColorGlow;
varying float vLifeCycleAlpha;

void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d = length(uv);

    float core = smoothstep(0.6, 0.0, d);
    float halo = exp(-d * d * 6.0) * 0.4;
    float alpha = (core + halo) * vLifeCycleAlpha;

    if (alpha < 0.01) discard;

    gl_FragColor = vec4(vColorGlow * (core + halo * 0.5), alpha);
}
`;

export class InstancedStreamSystem {
  constructor(scene) {
    this.scene = scene;
    this.activeBursts = [];
    this.geometry = new THREE.BufferGeometry();

    const positions = new Float32Array(MAX_INSTANCES * 3);
    const origins = new Float32Array(MAX_INSTANCES * 3);
    const seeds = new Float32Array(MAX_INSTANCES);
    const activationTimes = new Float32Array(MAX_INSTANCES);
    const intensities = new Float32Array(MAX_INSTANCES);
    const colors = new Float32Array(MAX_INSTANCES * 3);

    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aOriginInstance', new THREE.BufferAttribute(origins, 3));
    this.geometry.setAttribute('aParticleSeed', new THREE.BufferAttribute(seeds, 1));
    this.geometry.setAttribute('aActivationTime', new THREE.BufferAttribute(activationTimes, 1));
    this.geometry.setAttribute('aIntensity', new THREE.BufferAttribute(intensities, 1));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

    this.material = new THREE.ShaderMaterial({
      vertexShader: INSTANCED_VERTEX,
      fragmentShader: INSTANCED_FRAGMENT,
      uniforms: {
        uGlobalTime: { value: 0 },
        uTargetSectorCenter: { value: new THREE.Vector3(0, 0, 0) },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.scene.add(this.points);

    this.writeHead = 0;
    this.activeCount = 0;
  }

  inject(event) {
    const { vectorTarget, intensity, hexColor, originPosition } = event;
    if (!vectorTarget) return;

    const particlesPerBurst = Math.floor(intensity * 30) + 10;
    const globalTime = this.material.uniforms.uGlobalTime.value;
    const color = hexToRgb(hexColor || '#ffffff');
    const target = new THREE.Vector3(...vectorTarget);

    const origins = this.geometry.attributes.aOriginInstance;
    const seeds = this.geometry.attributes.aParticleSeed;
    const activations = this.geometry.attributes.aActivationTime;
    const intensitiesAttr = this.geometry.attributes.aIntensity;
    const colorsAttr = this.geometry.attributes.aColor;

    const origin = originPosition
      ? new THREE.Vector3(originPosition[0], originPosition[1], originPosition[2])
      : new THREE.Vector3((Math.random() - 0.5) * 3, 1.5, 2);

    for (let i = 0; i < particlesPerBurst; i++) {
      const idx = (this.writeHead + i) % MAX_INSTANCES;

      origins.setXYZ(idx,
        origin.x + (Math.random() - 0.5) * 0.3,
        origin.y + (Math.random() - 0.5) * 0.3,
        origin.z + (Math.random() - 0.5) * 0.3
      );
      seeds.setX(idx, Math.random() * 6.28);
      activations.setX(idx, globalTime + Math.random() * 0.3);
      intensitiesAttr.setX(idx, intensity * (0.7 + Math.random() * 0.3));
      colorsAttr.setXYZ(idx, color.r, color.g, color.b);
    }

    this.writeHead = (this.writeHead + particlesPerBurst) % MAX_INSTANCES;
    this.activeCount = Math.min(this.activeCount + particlesPerBurst, MAX_INSTANCES);

    origins.needsUpdate = true;
    seeds.needsUpdate = true;
    activations.needsUpdate = true;
    intensitiesAttr.needsUpdate = true;
    colorsAttr.needsUpdate = true;

    this.material.uniforms.uTargetSectorCenter.value.copy(target);
    this.geometry.setDrawRange(0, this.activeCount);

    this.activeBursts.push({ target, startTime: globalTime, duration: 2.0 });
  }

  update(time) {
    this.material.uniforms.uGlobalTime.value = time;

    // Update target for most recent active burst
    if (this.activeBursts.length > 0) {
      const latest = this.activeBursts[this.activeBursts.length - 1];
      this.material.uniforms.uTargetSectorCenter.value.copy(latest.target);
    }

    // Prune expired bursts
    for (let i = this.activeBursts.length - 1; i >= 0; i--) {
      if (time - this.activeBursts[i].startTime > this.activeBursts[i].duration) {
        this.activeBursts.splice(i, 1);
      }
    }
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
  };
}
