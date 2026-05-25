import * as THREE from 'three';

const SECTOR_COLORS = {
  PREFRONTAL: new THREE.Color('#ff3b30'),
  CONCEPT_LAYER: new THREE.Color('#ff9500'),
  HIPPOCAMPUS: new THREE.Color('#4cd964'),
  CEREBELLUM: new THREE.Color('#5ac8fa'),
  CONTEXT_CORTEX: new THREE.Color('#22d3ee'),
  TEMPORAL: new THREE.Color('#f59e0b'),
  PARIETAL: new THREE.Color('#34d399'),
  OCCIPITAL: new THREE.Color('#818cf8'),
};

const STREAM_VERTEX = `
uniform vec3 uStartPos;
uniform vec3 uTargetPos;
uniform float uTime;
attribute float aProgress;
varying float vAlpha;

void main() {
  float currentProgress = clamp(aProgress + uTime * 0.8, 0.0, 1.0);
  vec3 mixedPos = mix(uStartPos, uTargetPos, currentProgress);
  mixedPos.y += sin(currentProgress * 3.14159 * 2.0) * 0.3;
  mixedPos.x += cos(currentProgress * 4.71) * 0.1;

  vAlpha = sin(currentProgress * 3.14159);

  vec4 mvPosition = modelViewMatrix * vec4(mixedPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = 5.0 * (1.0 / -mvPosition.z);
}
`;

const STREAM_FRAGMENT = `
uniform vec3 uColor;
varying float vAlpha;

void main() {
  float distanceToCenter = length(gl_PointCoord - vec2(0.5));
  if (distanceToCenter > 0.5) discard;

  float strength = 1.0 - (distanceToCenter * 2.0);
  gl_FragColor = vec4(uColor * 1.5, strength * vAlpha * 0.9);
}
`;

export class SynapticStream {
  constructor(scene) {
    this.scene = scene;
    this.activeStreams = [];
  }

  emitStream(feedData, startPos, targetSectorPos) {
    const particleCount = Math.floor(feedData.intensity * 80) + 20;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const progress = new Float32Array(particleCount);

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = startPos.x + (Math.random() - 0.5) * 0.15;
      positions[i * 3 + 1] = startPos.y + (Math.random() - 0.5) * 0.15;
      positions[i * 3 + 2] = startPos.z + (Math.random() - 0.5) * 0.15;
      progress[i] = -(Math.random() * 0.6);
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aProgress', new THREE.Float32BufferAttribute(progress, 1));

    const color = SECTOR_COLORS[feedData.targetSector] || new THREE.Color('#ffffff');

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: color },
        uStartPos: { value: startPos.clone() },
        uTargetPos: { value: targetSectorPos.clone() },
        uTime: { value: 0 },
      },
      vertexShader: STREAM_VERTEX,
      fragmentShader: STREAM_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const pointCloud = new THREE.Points(geometry, material);
    this.scene.add(pointCloud);

    this.activeStreams.push({
      mesh: pointCloud,
      geometry,
      material,
      time: 0,
      duration: 1.8,
      feedData,
    });
  }

  getSectorPosition(sector) {
    const positions = {
      PREFRONTAL: new THREE.Vector3(0, 0.3, 0.8),
      CONCEPT_LAYER: new THREE.Vector3(-0.5, 0.1, 0.2),
      CONTEXT_CORTEX: new THREE.Vector3(0.5, 0.1, 0.2),
      TEMPORAL: new THREE.Vector3(-0.7, -0.3, -0.1),
      PARIETAL: new THREE.Vector3(0, 0.6, -0.2),
      OCCIPITAL: new THREE.Vector3(0, -0.1, -0.7),
      HIPPOCAMPUS: new THREE.Vector3(0, -0.4, 0.1),
      CEREBELLUM: new THREE.Vector3(0, -0.7, -0.4),
    };
    return positions[sector] || new THREE.Vector3(0, 0, 0);
  }

  update(deltaTime) {
    for (let i = this.activeStreams.length - 1; i >= 0; i--) {
      const stream = this.activeStreams[i];
      stream.time += deltaTime;
      stream.material.uniforms.uTime.value = stream.time;

      if (stream.time >= stream.duration) {
        this.scene.remove(stream.mesh);
        stream.geometry.dispose();
        stream.material.dispose();
        this.activeStreams.splice(i, 1);
      }
    }
  }

  get activeCount() {
    return this.activeStreams.length;
  }
}
