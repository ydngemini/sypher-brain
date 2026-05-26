/**
 * Main Three.js scene orchestrator.
 * Manages: camera, LOD brain mesh, particles, synapses, lighting, post-processing.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { generateHighPolyBrain } from './brain-geometry.js';
import { sampleInBrain, sampleInSector } from './brain-sampler.js';
import { VectorMemory } from './vector-memory.js';
import { ParticleSystem } from './particle-system.js';
import { SynapseNetwork } from './synapse-network.js';
import { SynapticStream } from './streams.js';
import { InstancedStreamSystem } from './instanced-streams.js';
import { BRAIN_REGIONS, mapToBrainPosition } from './regions.js';
import { getNodeColor, getGlowIntensity } from '../graph/color-scheme.js';

const EMBED_SERVER = 'http://127.0.0.1:5175';

const SECTOR_TO_CATEGORY = {
  PREFRONTAL: 'session',
  CONCEPT_LAYER: 'concept',
  CEREBELLUM: 'project',
  PARIETAL: 'decision',
  TEMPORAL: 'entity',
  OCCIPITAL: 'discovery',
  HIPPOCAMPUS: 'session',
  SENSORY_CORTEX: 'decision',
};

// Sector → display color. Mirrors the broker's UI palette.
const SECTOR_COLOR = {
  PREFRONTAL:     '#ff3b30',
  CONCEPT_LAYER:  '#ff9500',
  SENSORY_CORTEX: '#00e5f0',
  TEMPORAL:       '#f59e0b',
  PARIETAL:       '#34d399',
  OCCIPITAL:      '#818cf8',
  HIPPOCAMPUS:    '#4cd964',
  CEREBELLUM:     '#e633b4',
};

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
    this.onSelect = null;

    // Dual-source state
    this.vaultMap = new Map();      // noteId -> raw vault node
    this.obsMap = new Map();        // observation id -> raw observation
    this.semanticPos = new Map();   // key -> {x, y} (UMAP from embed-server)
    this.layerFilter = { vault: true, observations: true };
    this._embedQueue = new Map();   // key -> label (pending embed requests)
    this._embedTimer = null;
    this._rebuildTimer = null;

    // Per-node lifecycle animation (spawn + pulse)
    // Map<sceneNodeId, { birthTime, pulseStart, pulseIntensity, baseSize, baseGlow, particleIndex }>
    this._animatedNodes = new Map();
    this._seenNodes = new Set();     // ids we've rendered before — used to detect "new"
    this._brainPulse = 0;            // current scale-overshoot, decays each frame
    this._brainPulseTime = 0;

    // Edge persistence: synapses, once formed, do NOT get torn down on rebuild.
    // We keep a deduped accumulator and union it with newly-computed edges so
    // streams keep flowing even as new data lands.
    this._edgeKeys = new Set();
    this._maxPersistedEdges = 480_000;  // headroom below SynapseNetwork's 500k cap

    // "Feed neurons" — every NEURAL_FEED event from the broker becomes one
    // real neuron carrying that event's metadata. Capped at 1M so the brain
    // density is bounded by real activity, not faked.
    // Map<feedId, { particleIndex, sceneNode, embedding? }>
    this.feedNeurons = new Map();
    this._maxFeedNeurons = 999_000;  // total cap is 1M including ambient + vault + obs

    // Stable position cache — sample-in-brain once per node id, reuse forever.
    // Prevents flicker when _rebuildScene runs and keeps growth from rearranging
    // the brain's existing wiring.
    this._positionCache = new Map();

    // Reverse index for synapse formation by label — vault/obs/feed nodes
    // findable by their human label, so synapticAssociations (real broker
    // edges) can connect to real neurons.
    this._neuronByLabel = new Map();
    this._neuronById = new Map();

    // Vector memory: every new neuron gets embedded via the :5175 ONNX server,
    // and semantic synapses form to the top-K most similar existing neurons.
    this.vectorMem = new VectorMemory();

    // Callback fired when a synapse forms between two vault neurons — used by
    // the App to forward the connection to the vault-writer service so the
    // .md files learn about each other (Obsidian graph stays in sync).
    this.onVaultSynapse = null;

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
    // Anatomical brain: two hemispheres + cerebellum + brainstem
    const geometry = generateHighPolyBrain(56);

    // Faint translucent inner fill — gives the wireframe something to breathe over
    const fillMaterial = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0x140828),
      emissive: new THREE.Color(0x2a0d4a),
      emissiveIntensity: 0.25,
      metalness: 0.0,
      roughness: 0.85,
      transmission: 0.6,
      thickness: 0.4,
      ior: 1.1,
      transparent: true,
      opacity: 0.10,
      side: THREE.FrontSide,
      depthWrite: false,
    });
    const fill = new THREE.Mesh(geometry, fillMaterial);

    // Wireframe overlay — true edges only (clean geometric look, no diagonals)
    const wireGeo = new THREE.WireframeGeometry(geometry);
    const wireMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(0x9a6cff),
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      linewidth: 1,
    });
    const wire = new THREE.LineSegments(wireGeo, wireMaterial);

    // Rim wireframe — slightly larger, hotter color, lower opacity. Adds depth halo.
    const rimGeo = wireGeo;
    const rimMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(0xff3b6c),
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const rim = new THREE.LineSegments(rimGeo, rimMaterial);
    rim.scale.setScalar(1.012);

    this.brainGroup = new THREE.Group();
    this.brainGroup.add(fill);
    this.brainGroup.add(wire);
    this.brainGroup.add(rim);

    // Re-center: anatomical brain sits with brainstem below origin; pull it up so
    // the visual center of mass aligns with the scene origin and orbit target.
    this.brainGroup.position.y = 0.25;

    // LOD compatibility shim — animate loop calls brainLOD.update(camera)
    this.brainLOD = { update: () => {} };

    this.scene.add(this.brainGroup);
  }

  _initParticles() {
    // 1M cap — actual count grows with real activity, doesn't pre-fill
    this.particleSystem = new ParticleSystem(1_000_000);
    this.scene.add(this.particleSystem.getMesh());

    // Ambient — sampled INSIDE the brain mesh volume so they don't leak out
    // of the wireframe shell. Each one is tinted by which region of the
    // anatomical brain it landed in (rough lookup by 3D position).
    const ambient = [];
    for (let i = 0; i < 5000; i++) {
      const [x, y, z] = sampleInBrain();
      // Pick a region color by proximity to region centers
      let bestRegion = BRAIN_REGIONS[0];
      let bestDist = Infinity;
      for (const r of BRAIN_REGIONS) {
        const dx = r.center[0] - x, dy = r.center[1] - y, dz = r.center[2] - z;
        const d = dx*dx + dy*dy + dz*dz;
        if (d < bestDist) { bestDist = d; bestRegion = r; }
      }
      ambient.push({
        x, y, z,
        r: bestRegion.color[0],
        g: bestRegion.color[1],
        b: bestRegion.color[2],
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

    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this._handleClick();
    });
  }

  _handleClick() {
    if (!this.onSelect || this.nodes.length === 0) return;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObject(this.particleSystem.getMesh());
    if (intersects.length === 0) return;

    const idx = intersects[0].index;
    // First N indices in the particle buffer are ambient particles; vault/obs
    // nodes are appended after. Recover by offset.
    const ambientCount = this.ambientParticles.length;
    const nodeIdx = idx - ambientCount;
    if (nodeIdx < 0 || nodeIdx >= this.nodes.length) return;

    const node = this.nodes[nodeIdx];
    let source = null;
    if (node.source === 'vault') {
      // node.id is `vault:<noteId>` — strip prefix to get vault map key
      const noteId = node.id.startsWith('vault:') ? node.id.slice(6) : node.id;
      source = this.vaultMap.get(noteId);
    } else if (node.source === 'observation') {
      source = this.obsMap.get(node.observationId);
    }

    this.onSelect({ sceneNode: node, source });
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

    // Visible response: brain shell scale-pulses, and any neurons named in
    // the feed's synapticAssociations grow + glow briefly.
    const intensity = feedData.intensity || 0.5;
    this.pulseBrain(intensity);
    if (feedData.synapticAssociations && feedData.synapticAssociations.length > 0) {
      const labels = feedData.synapticAssociations.flatMap(a =>
        [a.targetNode, a.sourceNode].filter(Boolean)
      );
      this.pulseNodesByLabel(labels, intensity);
      this._dispatchGravityToWorker(feedData.synapticAssociations, targetPos);
    }
  }

  _dispatchGravityToWorker(associations, attractorPos) {
    if (this._workerBusy || this.nodes.length === 0) return;
    this._workerBusy = true;

    // Add new edges for the associations through the persistent dedup path
    const newAssocEdges = [];
    for (const assoc of associations) {
      const src = this.nodes.find(n =>
        n.label.toLowerCase().includes(assoc.sourceNode?.toLowerCase())
      );
      const tgt = this.nodes.find(n =>
        n.label.toLowerCase().includes(assoc.targetNode?.toLowerCase())
      );
      if (src && tgt) {
        newAssocEdges.push({
          from: src.position,
          to: tgt.position,
          activity: (assoc.weight || 0.5) * 0.6,
        });
      }
    }
    this._mergeEdges(newAssocEdges);
    this.edgeCount = this.edges.length;
    this.synapseNetwork.setEdges(this.edges);

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
      const ambientCount = this.ambientParticles.length;
      const nodeIdx = idx - ambientCount;
      if (nodeIdx >= 0 && nodeIdx < this.nodes.length) {
        const node = this.nodes[nodeIdx];
        this.onHover({
          label: node.label,
          category: node.category,
          color: node.hexColor,
          subtitle: node.subtitle,
          source: node.source,
        });
        this.canvas.style.cursor = 'pointer';
        return;
      }
    }
    this.canvas.style.cursor = 'grab';
    this.onHover(null);
  }

  // ---------- Unified vault + observation API ----------

  loadObservations(observations) {
    for (const obs of observations) {
      if (obs && (obs.id != null)) this.obsMap.set(obs.id, obs);
    }
    this._scheduleRebuild();
  }

  appendObservation(obs) {
    if (!obs || obs.id == null) return;
    this.obsMap.set(obs.id, obs);
    this._queueEmbed(`obs:${obs.id}`, obs.title || `Observation #${obs.id}`);
    this._scheduleRebuild();
  }

  updateObservations(observations) {
    // Back-compat shim — same as loadObservations now
    this.loadObservations(observations);
  }

  loadVaultBulk(nodes) {
    for (const n of nodes) {
      if (n && n.id) {
        this.vaultMap.set(n.id, n);
        this._queueEmbed(`vault:${n.id}`, n.label || n.id);
      }
    }
    this._scheduleRebuild();
  }

  addOrUpdateVaultNode(node) {
    if (!node || !node.id) return;
    this.vaultMap.set(node.id, node);
    this._queueEmbed(`vault:${node.id}`, node.label || node.id);
    this._scheduleRebuild();
  }

  removeVaultNode(id) {
    if (this.vaultMap.delete(id)) this._scheduleRebuild();
  }

  setLayerFilter(filter) {
    this.layerFilter = { ...this.layerFilter, ...filter };
    this._scheduleRebuild();
  }

  _scheduleRebuild() {
    if (this._rebuildTimer) return;
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = null;
      this._rebuildScene();
    }, 80);
  }

  _rebuildScene() {
    this.nodes = [];
    const particles = [...this.ambientParticles];
    const ambientCount = this.ambientParticles.length;
    const now = performance.now();

    if (this.layerFilter.vault) {
      const vaultArr = [...this.vaultMap.values()];
      for (let i = 0; i < vaultArr.length; i++) {
        const v = vaultArr[i];
        const key = `vault:${v.id}`;
        const category = v.category || SECTOR_TO_CATEGORY[v.sector] || 'concept';
        const color = getNodeColor(category, v.status === 'stale');
        const glow = v.status === 'stub' ? 0.4 : 0.85;
        // Stable position INSIDE the brain mesh — cached per node id so it
        // doesn't move on subsequent rebuilds.
        const position = this._stablePosition(key, v.sector);
        const rgb = hexToRGB(color);

        const node = {
          id: key,
          source: 'vault',
          label: v.label || v.id,
          category,
          hexColor: color,
          glow,
          position,
          subtitle: v.subtitle || `${v.dir}/${v.file || v.id}.md`,
          links: v.links || [],
          file: v.file,
        };
        this.nodes.push(node);
        this._indexNeuron(node);

        const baseSize = 0.9 + glow * 1.6;
        particles.push({
          x: position[0], y: position[1], z: position[2],
          r: rgb.r, g: rgb.g, b: rgb.b,
          glow,
          size: baseSize,
        });

        this._registerAnimatedNode(key, ambientCount + this.nodes.length - 1, baseSize, glow, now);
      }
    }

    if (this.layerFilter.observations) {
      const obsArr = [...this.obsMap.values()];
      for (let i = 0; i < obsArr.length; i++) {
        const obs = obsArr[i];
        const type = obs.type || 'discovery';
        const epoch = obs.created_at_epoch || obs.created_at || Date.now();
        const epochMs = typeof epoch === 'string' ? new Date(epoch).getTime() : epoch;
        const isStale = (Date.now() - epochMs) > 7 * 86400 * 1000;
        const color = getNodeColor(type, isStale);
        const glow = getGlowIntensity(epochMs);
        const key = `obs:${obs.id}`;
        const position = this._stablePosition(key, null);
        const rgb = hexToRGB(color);

        const node = {
          id: key,
          source: 'observation',
          observationId: obs.id,
          label: obs.title || `Observation #${obs.id}`,
          category: type,
          hexColor: color,
          glow,
          position,
          subtitle: obs.subtitle || (obs.narrative ? obs.narrative.slice(0, 200) : (obs.content ? obs.content.slice(0, 120) : null)),
        };
        this.nodes.push(node);
        this._indexNeuron(node);

        const baseSize = 0.7 + glow * 1.3;
        particles.push({
          x: position[0], y: position[1], z: position[2],
          r: rgb.r, g: rgb.g, b: rgb.b,
          glow,
          size: baseSize,
        });

        this._registerAnimatedNode(key, ambientCount + this.nodes.length - 1, baseSize, glow, now);
      }
    }

    this.particleSystem.setParticles(particles);

    // Feed neurons (grown from broker NEURAL_FEED events) live past the end of
    // the rebuild-managed range. setParticles above shrunk the count back to
    // ambient + vault + obs — we now re-append each feed neuron so it
    // survives. particleIndex is updated in-place in both the feedNeurons map
    // and any active animation entry.
    if (this.feedNeurons.size > 0) {
      for (const [, fn] of this.feedNeurons) {
        const n = fn.sceneNode;
        const rgb = hexToRGB(n.hexColor);
        const baseSize = 0.55 + (n.intensity || 0.5) * 0.9;
        const newIdx = this.particleSystem.appendParticles([{
          x: n.position[0], y: n.position[1], z: n.position[2],
          r: rgb.r, g: rgb.g, b: rgb.b,
          glow: n.glow,
          size: baseSize,
        }]);
        if (newIdx < 0) break; // hit cap
        fn.particleIndex = newIdx;
        const anim = this._animatedNodes.get(n.id);
        if (anim) anim.particleIndex = newIdx;
        // Keep nodes array in sync so click-picking still finds them
        this.nodes.push(n);
        this._indexNeuron(n);
      }
    }

    // Edges: compute the currently-implied set, then union with previously-
    // formed edges. Synapses persist across rebuilds — they don't reset when
    // new observations stream in or the layer toggle changes.
    const fresh = [];

    // Base brain wiring is always seeded (idempotent — same coords each call)
    for (const e of this.baseEdges) fresh.push(e);

    if (this.layerFilter.vault) {
      const byLabel = new Map();
      for (const n of this.nodes) {
        if (n.source === 'vault') {
          byLabel.set(n.label.toLowerCase(), n);
          byLabel.set((n.id.split(':').pop() || '').toLowerCase().replace(/_/g, ' '), n);
        }
      }
      for (const n of this.nodes) {
        if (n.source !== 'vault' || !n.links) continue;
        for (const link of n.links) {
          const tgt = byLabel.get(link.toLowerCase()) || byLabel.get(link.toLowerCase().replace(/_/g, ' '));
          if (tgt && tgt !== n) {
            fresh.push({ from: n.position, to: tgt.position, activity: 0.55 });
          }
        }
      }
    }

    if (this.layerFilter.vault && this.layerFilter.observations) {
      const vaultByWord = new Map();
      for (const n of this.nodes) {
        if (n.source === 'vault') {
          for (const word of n.label.toLowerCase().split(/\s+/)) {
            if (word.length > 4) vaultByWord.set(word, n);
          }
        }
      }
      for (const n of this.nodes) {
        if (n.source !== 'observation') continue;
        for (const word of n.label.toLowerCase().split(/\s+/)) {
          const vn = vaultByWord.get(word);
          if (vn) {
            fresh.push({ from: n.position, to: vn.position, activity: 0.35 });
            break;
          }
        }
      }
    }

    this._mergeEdges(fresh);
    this.nodeCount = this.nodes.length;
    this.edgeCount = this.edges.length;
    this.synapseNetwork.setEdges(this.edges);
  }

  // Union new edges into the persistent set, deduping by endpoint coords.
  // Returns the list of edges actually added (not duplicates) so callers can
  // push them to the GPU buffer in a single partial upload.
  _mergeEdges(fresh) {
    if (!this.edges) this.edges = [];
    if (!this._edgeKeys) this._edgeKeys = new Set();

    const keyOf = (e) =>
      `${e.from[0].toFixed(2)},${e.from[1].toFixed(2)},${e.from[2].toFixed(2)}|` +
      `${e.to[0].toFixed(2)},${e.to[1].toFixed(2)},${e.to[2].toFixed(2)}`;

    const added = [];
    for (const e of fresh) {
      const k = keyOf(e);
      if (this._edgeKeys.has(k)) continue;
      this._edgeKeys.add(k);
      this.edges.push(e);
      added.push(e);
    }

    if (this.edges.length > this._maxPersistedEdges) {
      const overflow = this.edges.length - this._maxPersistedEdges;
      const evicted = this.edges.splice(0, overflow);
      for (const e of evicted) this._edgeKeys.delete(keyOf(e));
    }

    return added;
  }

  // ---------- Brain-confined positioning + indexing ----------

  // Position deterministically per node id. First lookup samples a point
  // inside the brain mesh (possibly biased by sector); subsequent lookups
  // return the cached value so the brain's wiring doesn't shuffle.
  _stablePosition(id, sector) {
    let p = this._positionCache.get(id);
    if (!p) {
      p = sector ? sampleInSector(sector) : sampleInBrain();
      this._positionCache.set(id, p);
    }
    return p;
  }

  _indexNeuron(node) {
    const existing = this._neuronById.get(node.id);
    this._neuronById.set(node.id, node);
    if (node.label) {
      const k = node.label.toLowerCase();
      if (!this._neuronByLabel.has(k)) this._neuronByLabel.set(k, node);
    }
    // Fire embedding on first indexing only — vectorMem.embed itself dedupes
    // but we save the Promise/setup cost by gating here.
    if (!existing && (node.source === 'vault' || node.source === 'observation')) {
      const text = node.source === 'vault'
        ? (node.label + ' ' + (node.subtitle || ''))
        : (node.label + ' ' + (node.subtitle || ''));
      this._embedAndConnect(node, text);
    }
  }

  /**
   * Embed a node's label/payload via the ONNX server and, once the vector
   * is back, form semantic synapses to the top-K most similar existing
   * neurons. Fires the onVaultSynapse callback for any vault-to-vault
   * connection so the vault-writer can persist it to the .md files.
   */
  async _embedAndConnect(node, text) {
    if (!text) return;
    const vec = await this.vectorMem.embed(node.id, text);
    if (!vec) return;
    const matches = this.vectorMem.topK(vec, 3, node.id, 0.55);
    if (matches.length === 0) return;

    const newEdges = [];
    for (const { id: otherId, score } of matches) {
      const other = this._neuronById.get(otherId);
      if (!other || other === node) continue;
      newEdges.push({
        from: node.position,
        to: other.position,
        activity: 0.4 + score * 0.5,
      });
      // Vault-to-vault semantic synapse → tell the app so it can write
      // a [[wikilink]] into the vault.
      if (node.source === 'vault' && other.source === 'vault' && this.onVaultSynapse) {
        this.onVaultSynapse({
          sourceId: node.id,
          sourceLabel: node.label,
          sourceFile: node.file,
          targetId: other.id,
          targetLabel: other.label,
          targetFile: other.file,
          score,
        });
      }
    }
    if (newEdges.length > 0) {
      const added = this._mergeEdges(newEdges);
      if (added.length > 0) this.synapseNetwork.appendEdges(added);
      this.edgeCount = this.edges.length;
    }
  }

  // ---------- Real growth: each broker feed becomes a neuron + synapses ----

  /**
   * Spawn one real neuron representing this NEURAL_FEED event. Positions it
   * inside the brain shell in the appropriate sector. Forms synapses for
   * every entry in feed.synapticAssociations whose label matches an existing
   * neuron — those are REAL relations the broker reported.
   *
   * Caps at this._maxFeedNeurons (default 999k). At cap, oldest feed neurons
   * are NOT deleted (the synapse buffer would lose its anchor); we simply
   * stop appending. The brain saturates rather than churns.
   */
  growFromFeed(feed) {
    if (!feed?.id || !feed?.agentId) return;
    if (this.feedNeurons.has(feed.id)) return;
    if (this.feedNeurons.size >= this._maxFeedNeurons) return;

    const sector = feed.targetSector;
    const position = this._stablePosition(`feed:${feed.id}`, sector);
    const color = SECTOR_COLOR[sector] || '#a78bfa';
    const intensity = Math.max(0, Math.min(1, feed.intensity ?? 0.5));
    const baseGlow = 0.3 + intensity * 0.55;
    const baseSize = 0.55 + intensity * 0.9;
    const rgb = hexToRGB(color);

    const node = {
      id: `feed:${feed.id}`,
      source: 'feed',
      feedId: feed.id,
      agentId: feed.agentId,
      label: feed.payloadSummary || feed.agentId,
      category: SECTOR_TO_CATEGORY[sector] || 'discovery',
      hexColor: color,
      glow: baseGlow,
      position,
      subtitle: `${feed.agentId} · ${sector}`,
      timestamp: feed.timestamp || Date.now(),
      payloadSummary: feed.payloadSummary,
      intensity,
    };

    // Append to GPU buffer (partial upload — no 32MB re-transfer)
    const particleIndex = this.particleSystem.appendParticles([{
      x: position[0], y: position[1], z: position[2],
      r: rgb.r, g: rgb.g, b: rgb.b,
      glow: baseGlow,
      size: baseSize,
    }]);
    if (particleIndex < 0) return; // hit hard cap

    this.nodes.push(node);
    this._indexNeuron(node);
    this.feedNeurons.set(feed.id, { particleIndex, sceneNode: node });

    // Track for the spawn-growth animation (handled in _animationTick)
    this._seenNodes.add(node.id);
    this._animatedNodes.set(node.id, {
      birthTime: performance.now(),
      pulseStart: 0,
      pulseIntensity: 0,
      particleIndex,
      baseSize,
      baseGlow,
    });

    // Real synapses: connect this new neuron to every existing neuron whose
    // label matches one of the broker's reported synapticAssociations.
    const newEdges = [];
    if (feed.synapticAssociations) {
      for (const assoc of feed.synapticAssociations) {
        const tgtLabel = (assoc.targetNode || '').toLowerCase();
        const srcLabel = (assoc.sourceNode || '').toLowerCase();
        const tgt = this._neuronByLabel.get(tgtLabel);
        const src = this._neuronByLabel.get(srcLabel);
        if (tgt && tgt.id !== node.id) {
          newEdges.push({ from: node.position, to: tgt.position, activity: (assoc.weight ?? 0.6) });
        }
        if (src && src.id !== node.id) {
          newEdges.push({ from: src.position, to: node.position, activity: (assoc.weight ?? 0.6) });
        }
      }
    }

    // Also wire this neuron to a small neighborhood of nearby (already-placed)
    // feed neurons from the same sector — encodes the lived-experience cluster
    // that an active region of the brain naturally builds up. We pick at most
    // K to keep edge count proportional to actual activity, not quadratic.
    const K_LOCAL = 2;
    const localCandidates = [];
    for (const [, fn] of this.feedNeurons) {
      const other = fn.sceneNode;
      if (!other || other.id === node.id) continue;
      if (other.category !== node.category) continue;
      const d = Math.hypot(
        other.position[0] - position[0],
        other.position[1] - position[1],
        other.position[2] - position[2],
      );
      if (d < 0.35) localCandidates.push({ node: other, d });
    }
    localCandidates.sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(K_LOCAL, localCandidates.length); i++) {
      newEdges.push({
        from: node.position,
        to: localCandidates[i].node.position,
        activity: 0.35 + intensity * 0.3,
      });
    }

    if (newEdges.length > 0) {
      const added = this._mergeEdges(newEdges);
      if (added.length > 0) this.synapseNetwork.appendEdges(added);
      this.edgeCount = this.edges.length;
    }

    this.nodeCount = this.nodes.length;

    // Semantic synapses — fire-and-forget; arrive after the embed-server
    // returns (~100-300ms) and append more edges then.
    this._embedAndConnect(node, feed.payloadSummary);
  }

  // ---------- Lifecycle animation: spawn growth + impact pulse ----------

  _registerAnimatedNode(key, particleIndex, baseSize, baseGlow, now) {
    const existing = this._animatedNodes.get(key);
    const isNew = !this._seenNodes.has(key);
    if (isNew) this._seenNodes.add(key);

    if (existing) {
      // Update particleIndex + baseline; preserve any active pulse/birth
      existing.particleIndex = particleIndex;
      existing.baseSize = baseSize;
      existing.baseGlow = baseGlow;
    } else {
      this._animatedNodes.set(key, {
        birthTime: isNew ? now : 0,
        pulseStart: 0,
        pulseIntensity: 0,
        particleIndex,
        baseSize,
        baseGlow,
      });
    }
  }

  // Briefly scale-pulse the brain shell. Called on every walker arrival.
  pulseBrain(intensity = 0.5) {
    // 0.05 = max 5% scale-up for intensity=1
    this._brainPulse = Math.min(0.06, this._brainPulse + intensity * 0.045);
  }

  // Mark a specific neuron to grow + glow briefly.
  pulseNode(sceneNodeId, intensity = 0.5) {
    const anim = this._animatedNodes.get(sceneNodeId);
    if (!anim) return;
    anim.pulseStart = performance.now();
    anim.pulseIntensity = Math.max(anim.pulseIntensity, Math.min(1, intensity));
  }

  // Find neurons by label substring match — used when broker feeds carry
  // synapticAssociations whose targetNode names a real vault/obs entity.
  pulseNodesByLabel(labels, intensity = 0.5) {
    if (!labels || labels.length === 0) return;
    const needles = labels.map(l => String(l).toLowerCase()).filter(Boolean);
    for (const node of this.nodes) {
      const hay = node.label.toLowerCase();
      for (const n of needles) {
        if (hay.includes(n) || n.includes(hay)) {
          this.pulseNode(node.id, intensity);
          break;
        }
      }
    }
  }

  _animationTick(now) {
    // Brain shell pulse decay
    if (this._brainPulse > 0.0001) {
      this._brainPulse *= 0.92;
      if (this.brainGroup) {
        const s = 1 + this._brainPulse;
        this.brainGroup.scale.set(s, s, s);
      }
    } else if (this._brainPulse !== 0) {
      this._brainPulse = 0;
      if (this.brainGroup) this.brainGroup.scale.set(1, 1, 1);
    }

    if (this._animatedNodes.size === 0) return;

    const SPAWN_MS = 900;
    const PULSE_MS = 750;

    for (const [, anim] of this._animatedNodes) {
      if (anim.particleIndex == null || anim.particleIndex >= this.particleSystem.count) {
        continue;
      }

      // Spawn ramp 0→1 over SPAWN_MS (easeOutCubic)
      let spawnFactor = 1;
      if (anim.birthTime > 0) {
        const t = (now - anim.birthTime) / SPAWN_MS;
        if (t < 1) {
          const u = 1 - t;
          spawnFactor = 1 - u * u * u;
        } else {
          anim.birthTime = 0;
        }
      }

      // Pulse: bell curve, peak ~0.15 of duration
      let pulseFactor = 0;
      if (anim.pulseStart > 0) {
        const t = (now - anim.pulseStart) / PULSE_MS;
        if (t < 1) {
          pulseFactor = anim.pulseIntensity * Math.exp(-Math.pow((t - 0.15) * 3.5, 2));
        } else {
          anim.pulseStart = 0;
          anim.pulseIntensity = 0;
        }
      }

      // Only write to the GPU buffer when this node is actually animating.
      // At rest, leave the particle attributes at their baseline values that
      // _rebuildScene already wrote — saves per-frame buffer churn for ~150
      // idle entries.
      if (anim.birthTime === 0 && anim.pulseStart === 0) continue;

      const size = anim.baseSize * spawnFactor * (1 + pulseFactor * 2.0);
      const glow = Math.min(1, anim.baseGlow * spawnFactor + pulseFactor * 0.7);

      this.particleSystem.updateSize(anim.particleIndex, size);
      this.particleSystem.updateGlow(anim.particleIndex, glow);
    }
  }

  // ---------- Semantic positioning via :5175 embed-server ----------

  _applySemanticOffset(key, basePos, sectorHint) {
    const sem = this.semanticPos.get(key);
    if (!sem) return basePos;
    // Treat embed UMAP as a local offset in the tangent plane of the region center.
    const scale = 0.18;
    return [
      basePos[0] + sem.x * scale,
      basePos[1] + sem.y * scale,
      basePos[2] + (sem.x * sem.y > 0 ? 0.04 : -0.04),
    ];
  }

  _queueEmbed(key, label) {
    if (!label || this.semanticPos.has(key)) return;
    this._embedQueue.set(key, label);
    if (this._embedTimer) return;
    this._embedTimer = setTimeout(() => this._flushEmbedQueue(), 600);
  }

  async _flushEmbedQueue() {
    this._embedTimer = null;
    const entries = [...this._embedQueue.entries()];
    this._embedQueue.clear();
    if (!entries.length) return;

    const payload = { nodes: entries.map(([id, label]) => ({ id, label })) };

    try {
      const res = await fetch(`${EMBED_SERVER}/api/positions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const data = await res.json();
      const positions = data.positions || {};

      // Per-batch normalize: find max |coord| across this batch, scale to [-1,1].
      // UMAP output range varies wildly batch-to-batch (~10 to ~10000), so a
      // fixed divisor either over- or under-scatters nodes within their region.
      let maxAbs = 0;
      for (const pos of Object.values(positions)) {
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
          maxAbs = Math.max(maxAbs, Math.abs(pos.x), Math.abs(pos.y));
        }
      }
      if (maxAbs === 0) return;

      let changed = false;
      for (const [id, pos] of Object.entries(positions)) {
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
          this.semanticPos.set(id, { x: pos.x / maxAbs, y: pos.y / maxAbs });
          changed = true;
        }
      }
      if (changed) this._scheduleRebuild();
    } catch {
      // embed server might be cold-loading the ONNX model; try again later
      for (const [id, label] of entries) {
        if (!this.semanticPos.has(id)) this._embedQueue.set(id, label);
      }
      if (!this._embedTimer) this._embedTimer = setTimeout(() => this._flushEmbedQueue(), 5000);
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
    this._animationTick(performance.now());

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
