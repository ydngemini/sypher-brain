/**
 * Main Three.js scene orchestrator.
 * Manages: camera, LOD brain mesh, particles, synapses, lighting, post-processing.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { generateHighPolyBrain, generateLODs, bakeNormalMap } from './brain-geometry.js';
import { createBrainMaterial } from './materials.js';
import { ParticleSystem } from './particle-system.js';
import { SynapseNetwork } from './synapse-network.js';
import { SynapticStream } from './streams.js';
import { InstancedStreamSystem } from './instanced-streams.js';
import { BRAIN_REGIONS, mapToBrainPosition } from './regions.js';
import { getNodeColor, getGlowIntensity } from '../graph/color-scheme.js';

function hexToRGB(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

export class BrainScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.nodes = [];
    this.edges = [];
    this.nodeCount = 0;
    this.edgeCount = 0;
    this.onHover = null;

    this._initRenderer();
    this._initScene();
    this._initCamera();
    this._initControls();
    this._initLighting();
    this._initBrain();
    this._initParticles();
    this._initSynapses();
    this._initPostProcessing();
    this._initLabels();
    this._initRaycaster();
    this._initStreams();
    this._initLayoutWorker();

    this.clock = new THREE.Clock();
    this._animate = this._animate.bind(this);
    this._animate();
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.canvas.parentElement.clientWidth, this.canvas.parentElement.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.8;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    window.addEventListener('resize', () => this._onResize());
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030306);
    this.scene.fog = new THREE.FogExp2(0x030306, 0.04);
  }

  _initCamera() {
    const aspect = this.canvas.parentElement.clientWidth / this.canvas.parentElement.clientHeight;
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 100);
    this.camera.position.set(0, 0.5, 4.5);
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;
    this.controls.minDistance = 2.0;
    this.controls.maxDistance = 12;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.3;
    this.controls.target.set(0, 0, 0);
  }

  _initLighting() {
    const ambient = new THREE.AmbientLight(0x0a0518, 0.3);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0x3a2a80, 0.3);
    key.position.set(2, 3, 2);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x1a0a3e, 0.15);
    fill.position.set(-2, -1, -2);
    this.scene.add(fill);

    const rim = new THREE.PointLight(0x801030, 0.2, 10);
    rim.position.set(0, -1, -2);
    this.scene.add(rim);
  }

  _initBrain() {
    const highPoly = generateHighPolyBrain(96);
    const normalMap = bakeNormalMap(highPoly, 512);
    const material = createBrainMaterial(normalMap);

    // LOD system
    this.brainLOD = new THREE.LOD();
    const lods = generateLODs(highPoly);

    for (const { geometry, distance } of lods) {
      const mesh = new THREE.Mesh(geometry, material);
      this.brainLOD.addLevel(mesh, distance);
    }

    this.scene.add(this.brainLOD);
  }

  _initParticles() {
    this.particleSystem = new ParticleSystem(8000);
    this.scene.add(this.particleSystem.getMesh());

    // Generate ambient brain particles
    const ambient = [];
    for (let i = 0; i < 5000; i++) {
      const region = BRAIN_REGIONS[i % BRAIN_REGIONS.length];
      const spread = region.radius * 0.5;
      const pos = mapToBrainPosition(i, 5000, region.name === 'PREFRONTAL' ? 'project' : 'concept');

      ambient.push({
        x: pos[0] + (Math.random() - 0.5) * spread,
        y: pos[1] + (Math.random() - 0.5) * spread,
        z: pos[2] + (Math.random() - 0.5) * spread,
        r: region.color[0],
        g: region.color[1],
        b: region.color[2],
        glow: 0.03 + Math.random() * 0.1,
        size: 0.3 + Math.random() * 0.6,
      });
    }

    this.ambientParticles = ambient;
    this.particleSystem.setParticles(ambient);
  }

  _initSynapses() {
    this.synapseNetwork = new SynapseNetwork(2000);
    this.scene.add(this.synapseNetwork.getMesh());

    // Base synapses between regions
    const baseEdges = [];
    const regionPairs = [
      [0,1],[0,2],[1,3],[2,5],[0,4],[4,5],[3,6],[6,7],[1,4],[2,4],[5,7],[3,5],[0,6],[1,6],[2,3],[4,7]
    ];
    for (const [a, b] of regionPairs) {
      baseEdges.push({
        from: BRAIN_REGIONS[a].center,
        to: BRAIN_REGIONS[b].center,
        activity: 0.3 + Math.random() * 0.2
      });
    }

    // Intra-region connections from ambient particles
    for (let r = 0; r < BRAIN_REGIONS.length; r++) {
      const regionParticles = this.ambientParticles.filter((_, i) => i % BRAIN_REGIONS.length === r);
      for (let i = 0; i < Math.min(regionParticles.length - 1, 20); i += 3) {
        const a = regionParticles[i];
        const b = regionParticles[i + 1];
        if (a && b) {
          baseEdges.push({
            from: [a.x, a.y, a.z],
            to: [b.x, b.y, b.z],
            activity: 0.15 + Math.random() * 0.15
          });
        }
      }
    }

    this.baseEdges = baseEdges;
    this.edges = [...baseEdges];
    this.edgeCount = this.edges.length;
    this.synapseNetwork.setEdges(this.edges);
  }

  _initPostProcessing() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    const bloom = new UnrealBloomPass(
      new THREE.Vector2(this.canvas.width, this.canvas.height),
      0.4,    // strength — subtle glow, not washed out
      0.3,    // radius
      0.6     // threshold — only bright things bloom
    );
    this.composer.addPass(bloom);
    this.bloomPass = bloom;
  }

  _initLabels() {
    this.labels = [];
    for (const region of BRAIN_REGIONS) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const fontSize = 48;
      ctx.font = `bold ${fontSize}px "JetBrains Mono", monospace`;
      const width = Math.ceil(ctx.measureText(region.name).width) + 20;
      canvas.width = width;
      canvas.height = fontSize + 16;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `bold ${fontSize}px "JetBrains Mono", monospace`;
      ctx.fillStyle = `rgba(${Math.floor(region.color[0]*255)},${Math.floor(region.color[1]*255)},${Math.floor(region.color[2]*255)}, 0.85)`;
      ctx.textBaseline = 'middle';
      ctx.fillText(region.name, 10, canvas.height / 2);

      const texture = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      });

      const sprite = new THREE.Sprite(mat);
      const scale = 0.22;
      sprite.scale.set(scale * (width / canvas.height), scale * 0.5, 1);
      sprite.position.set(region.center[0], region.center[1] + 0.25, region.center[2]);
      this.scene.add(sprite);
      this.labels.push(sprite);
    }
  }

  _initRaycaster() {
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points.threshold = 0.05;
    this.mouse = new THREE.Vector2();

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this._checkHover();
    });

    this.canvas.addEventListener('click', () => {
      this._checkHover();
    });
  }

  _initStreams() {
    this.synapticStream = new SynapticStream(this.scene);
    this.instancedStreams = new InstancedStreamSystem(this.scene);
  }

  _initLayoutWorker() {
    this.layoutWorker = new Worker(new URL('./graph-worker.js', import.meta.url));
    this._workerBusy = false;

    this.layoutWorker.onmessage = (e) => {
      this._workerBusy = false;

      if (e.data.type === 'GRAVITY_COMPUTED' || e.data.type === 'REPULSION_COMPUTED') {
        const updated = e.data.updatedNodes;
        for (let i = 0; i < updated.length && i < this.nodes.length; i++) {
          this.nodes[i].position = updated[i].position;
          this.nodes[i].glow = updated[i].glow;
        }
        this._rebuildParticlesFromNodes();
      }
    };
  }

  _rebuildParticlesFromNodes() {
    const particles = [...this.ambientParticles];

    for (const node of this.nodes) {
      const rgb = hexToRGB(node.hexColor);
      particles.push({
        x: node.position[0],
        y: node.position[1],
        z: node.position[2],
        r: rgb.r, g: rgb.g, b: rgb.b,
        glow: node.glow,
        size: 0.8 + node.glow * 1.2,
      });
    }

    this.particleSystem.setParticles(particles);
    this.synapseNetwork.setEdges(this.edges);
  }

  injectFeed(feedData) {
    const targetPos = this.synapticStream.getSectorPosition(feedData.targetSector);
    const camera = this.camera;
    const startPos = new THREE.Vector3(
      camera.position.x + (Math.random() - 0.5) * 0.5,
      camera.position.y - 0.8,
      camera.position.z - 0.5
    );
    this.synapticStream.emitStream(feedData, startPos, targetPos);

    // Fire instanced GPU stream for hardware-accelerated rendering
    this.instancedStreams.inject({
      vectorTarget: feedData.vectorTarget || [targetPos.x, targetPos.y, targetPos.z],
      intensity: feedData.intensity || 0.5,
      hexColor: feedData.hexColor || '#ff9500',
      originPosition: [startPos.x, startPos.y, startPos.z],
    });

    // Offload gravitational pull to Web Worker (keeps render thread at 60fps)
    if (feedData.synapticAssociations && feedData.synapticAssociations.length > 0) {
      this._dispatchGravityToWorker(feedData.synapticAssociations, targetPos);
    }
  }

  _dispatchGravityToWorker(associations, attractorPos) {
    if (this._workerBusy || this.nodes.length === 0) return;
    this._workerBusy = true;

    // Add new edges for the associations before dispatching
    for (const assoc of associations) {
      const src = this.nodes.find(n =>
        n.label.toLowerCase().includes(assoc.sourceNode?.toLowerCase())
      );
      const tgt = this.nodes.find(n =>
        n.label.toLowerCase().includes(assoc.targetNode?.toLowerCase())
      );
      if (src && tgt) {
        this.edges.push({
          from: src.position,
          to: tgt.position,
          activity: assoc.weight * 0.6,
        });
      }
    }
    this.edgeCount = this.edges.length;

    this.layoutWorker.postMessage({
      type: 'COMPUTE_GRAVITY_PULL',
      nodes: this.nodes.map(n => ({ label: n.label, position: [...n.position], glow: n.glow })),
      associations,
      attractorPos: [attractorPos.x, attractorPos.y, attractorPos.z],
    });
  }

  _checkHover() {
    if (!this.onHover || this.nodes.length === 0) return;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObject(this.particleSystem.getMesh());

    if (intersects.length > 0) {
      const idx = intersects[0].index;
      if (idx < this.nodes.length) {
        const node = this.nodes[idx];
        this.onHover({
          label: node.label,
          category: node.category,
          color: node.hexColor,
          subtitle: node.subtitle
        });
        this.canvas.style.cursor = 'pointer';
        return;
      }
    }
    this.canvas.style.cursor = 'grab';
    this.onHover(null);
  }

  loadObservations(observations) {
    this.nodes = [];
    const particles = [...this.ambientParticles];

    for (let i = 0; i < observations.length; i++) {
      const obs = observations[i];
      const type = obs.type || 'discovery';
      const epoch = obs.created_at_epoch || Date.now();
      const isStale = (Date.now() - epoch) > 7 * 86400 * 1000;
      const color = getNodeColor(type, isStale);
      const glow = getGlowIntensity(epoch);
      const position = mapToBrainPosition(i, observations.length, type);
      const rgb = hexToRGB(color);

      const node = {
        id: obs.id,
        label: obs.title || `Observation #${obs.id}`,
        category: type,
        hexColor: color,
        glow,
        position,
        subtitle: obs.content ? obs.content.slice(0, 120) : null
      };
      this.nodes.push(node);

      particles.push({
        x: position[0],
        y: position[1],
        z: position[2],
        r: rgb.r,
        g: rgb.g,
        b: rgb.b,
        glow,
        size: 0.8 + glow * 1.2,
      });
    }

    this.particleSystem.setParticles(particles);

    // Build edges from data
    this.edges = [...this.baseEdges];
    const byCategory = {};
    for (const node of this.nodes) {
      if (!byCategory[node.category]) byCategory[node.category] = [];
      byCategory[node.category].push(node);
    }
    for (const nodes of Object.values(byCategory)) {
      for (let i = 0; i < nodes.length - 1; i++) {
        this.edges.push({
          from: nodes[i].position,
          to: nodes[i + 1].position,
          activity: (nodes[i].glow + nodes[i + 1].glow) * 0.4
        });
      }
    }

    // Cross-category for active
    const active = this.nodes.filter(n => n.glow > 0.3);
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < Math.min(active.length, i + 4); j++) {
        const d = Math.sqrt(
          (active[i].position[0] - active[j].position[0]) ** 2 +
          (active[i].position[1] - active[j].position[1]) ** 2 +
          (active[i].position[2] - active[j].position[2]) ** 2
        );
        if (d < 0.8) {
          this.edges.push({
            from: active[i].position,
            to: active[j].position,
            activity: (active[i].glow + active[j].glow) * 0.3
          });
        }
      }
    }

    this.nodeCount = this.nodes.length;
    this.edgeCount = this.edges.length;
    this.synapseNetwork.setEdges(this.edges);
  }

  updateObservations(observations) {
    let changed = false;
    for (const obs of observations) {
      const existing = this.nodes.find(n => n.id === obs.id);
      if (existing) {
        const newGlow = getGlowIntensity(obs.created_at_epoch || Date.now());
        if (newGlow > existing.glow) {
          existing.glow = newGlow;
          changed = true;
        }
      } else {
        const type = obs.type || 'discovery';
        const epoch = obs.created_at_epoch || Date.now();
        const isStale = (Date.now() - epoch) > 7 * 86400 * 1000;
        const color = getNodeColor(type, isStale);
        const glow = getGlowIntensity(epoch);
        const position = mapToBrainPosition(this.nodes.length, this.nodes.length + 1, type);

        this.nodes.push({
          id: obs.id,
          label: obs.title || `Observation #${obs.id}`,
          category: type,
          hexColor: color,
          glow,
          position,
          subtitle: obs.content ? obs.content.slice(0, 120) : null
        });
        changed = true;
      }
    }

    if (changed) {
      this.loadObservations(observations);
    }
  }

  _animate() {
    this._rafId = requestAnimationFrame(this._animate);
    const delta = this.clock.getDelta();
    const time = this.clock.elapsedTime;

    this.controls.update();
    this.brainLOD.update(this.camera);

    this.particleSystem.update(time);
    this.synapseNetwork.update(time);
    this.synapticStream.update(delta);
    this.instancedStreams.update(time);

    // Label opacity based on camera distance
    const dist = this.camera.position.length();
    const labelOpacity = THREE.MathUtils.clamp((dist - 2.0) / 3, 0.2, 0.6);
    for (const label of this.labels) {
      label.material.opacity = labelOpacity;
    }

    this.composer.render();
  }

  _onResize() {
    const w = this.canvas.parentElement.clientWidth;
    const h = this.canvas.parentElement.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  destroy() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
