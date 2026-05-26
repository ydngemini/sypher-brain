/**
 * Animated synapse connections with traveling energy pulses.
 * Uses custom shader for per-edge activity and pulse animation.
 */
import * as THREE from 'three';

const SYNAPSE_VERTEX = `
uniform float u_time;
attribute float a_activity;
attribute float a_progress;

varying float v_activity;
varying float v_progress;

void main() {
  v_activity = a_activity;
  v_progress = a_progress;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SYNAPSE_FRAGMENT = `
uniform float u_time;
varying float v_activity;
varying float v_progress;

void main() {
  float travel = fract(v_progress - u_time * 1.5);
  float pulse = exp(-travel * travel * 8.0) * v_activity;

  float travel2 = fract(v_progress - u_time * 0.8 + 0.5);
  float pulse2 = exp(-travel2 * travel2 * 12.0) * v_activity * 0.5;

  vec3 color = vec3(0.3, 0.2, 0.6) + (pulse + pulse2) * vec3(0.5, 0.3, 0.9);
  float alpha = 0.15 + pulse * 0.7 + pulse2 * 0.3 + v_activity * 0.2;

  gl_FragColor = vec4(color * 1.4, alpha);
}
`;

export class SynapseNetwork {
  constructor(maxEdges = 500_000) {
    this.maxEdges = maxEdges;
    this.edgeCount = 0;

    const maxVerts = maxEdges * 2;
    const positions = new Float32Array(maxVerts * 3);
    const activities = new Float32Array(maxVerts);
    const progresses = new Float32Array(maxVerts);

    const posAttr = new THREE.BufferAttribute(positions, 3);
    const actAttr = new THREE.BufferAttribute(activities, 1);
    const progAttr = new THREE.BufferAttribute(progresses, 1);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    actAttr.setUsage(THREE.DynamicDrawUsage);
    progAttr.setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('a_activity', actAttr);
    geometry.setAttribute('a_progress', progAttr);

    const material = new THREE.ShaderMaterial({
      vertexShader: SYNAPSE_VERTEX,
      fragmentShader: SYNAPSE_FRAGMENT,
      uniforms: {
        u_time: { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.mesh = new THREE.LineSegments(geometry, material);
    this.geometry = geometry;
    this.material = material;
  }

  setEdges(edges) {
    const pos = this.geometry.attributes.position;
    const act = this.geometry.attributes.a_activity;
    const prog = this.geometry.attributes.a_progress;

    this.edgeCount = Math.min(edges.length, this.maxEdges);

    for (let i = 0; i < this.edgeCount; i++) {
      const e = edges[i];
      const idx = i * 2;
      pos.setXYZ(idx, e.from[0], e.from[1], e.from[2]);
      pos.setXYZ(idx + 1, e.to[0], e.to[1], e.to[2]);
      act.setX(idx, e.activity);
      act.setX(idx + 1, e.activity);
      prog.setX(idx, 0);
      prog.setX(idx + 1, 1);
    }

    pos.needsUpdate = true;
    act.needsUpdate = true;
    prog.needsUpdate = true;
    this.geometry.setDrawRange(0, this.edgeCount * 2);
  }

  // Append new edges to the existing buffer — only the new range is uploaded
  // to the GPU, so growing the network doesn't re-transfer everything.
  appendEdges(edges) {
    if (!edges || edges.length === 0) return 0;
    if (this.edgeCount >= this.maxEdges) return 0;

    const pos = this.geometry.attributes.position;
    const act = this.geometry.attributes.a_activity;
    const prog = this.geometry.attributes.a_progress;

    const startEdge = this.edgeCount;
    const limit = Math.min(edges.length, this.maxEdges - startEdge);

    for (let i = 0; i < limit; i++) {
      const e = edges[i];
      const idx = (startEdge + i) * 2;
      pos.setXYZ(idx, e.from[0], e.from[1], e.from[2]);
      pos.setXYZ(idx + 1, e.to[0], e.to[1], e.to[2]);
      const a = e.activity ?? 0.5;
      act.setX(idx, a);
      act.setX(idx + 1, a);
      prog.setX(idx, 0);
      prog.setX(idx + 1, 1);
    }

    this.edgeCount += limit;
    const vStart = startEdge * 2;
    const vCount = limit * 2;
    if (pos.addUpdateRange) {
      pos.addUpdateRange(vStart * 3, vCount * 3);
      act.addUpdateRange(vStart, vCount);
      prog.addUpdateRange(vStart, vCount);
    }
    pos.needsUpdate = true;
    act.needsUpdate = true;
    prog.needsUpdate = true;
    this.geometry.setDrawRange(0, this.edgeCount * 2);
    return limit;
  }

  update(time) {
    this.material.uniforms.u_time.value = time;
  }

  getMesh() {
    return this.mesh;
  }
}
