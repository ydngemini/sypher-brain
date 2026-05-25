import { useEffect, useRef, useState } from 'react';
import { BrainScene } from './engine/scene.js';
import { fetchObservations, feedBrain } from './graph/data-source.js';
import { NODE_COLORS } from './graph/color-scheme.js';
import { useBroker } from './agents/useBroker.js';
import { AgentSpriteManager } from './agents/AgentSpriteManager.js';
import AgentGrid from './agents/AgentGrid.jsx';
import './agents/AgentSprite.css';

export default function App() {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0, active: 0, particles: 5000 });
  const [hoveredNode, setHoveredNode] = useState(null);
  const [query, setQuery] = useState('');
  const [feeding, setFeeding] = useState(false);
  const { agents, feeds, connected, onFeed, onSynapse } = useBroker();
  const spriteRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    const brain = new BrainScene(canvasRef.current);
    sceneRef.current = brain;
    brain.onHover = (node) => setHoveredNode(node);

    async function init() {
      const observations = await fetchObservations(300);
      if (observations.length > 0) {
        brain.loadObservations(observations);
      }
      setStats({
        nodes: brain.nodeCount,
        edges: brain.edgeCount,
        active: brain.nodes.filter(n => n.glow > 0.5).length,
        particles: 5000 + brain.nodeCount
      });
    }

    init();

    // Initialize sprite manager
    if (rootRef.current && !spriteRef.current) {
      spriteRef.current = new AgentSpriteManager(rootRef.current);
    }

    // On synapse-impact (sprite arrival), trigger 3D particle stream
    const handleImpact = (e) => {
      if (brain && e.detail.feedData) {
        brain.injectFeed(e.detail.feedData);
      }
    };
    window.addEventListener('synapse-impact', handleImpact);

    // Wire SYNAPSE_ACTIVATION (shell telemetry) directly to instanced GPU system
    onSynapse((event) => {
      if (brain && event.agent) {
        brain.instancedStreams.inject({
          vectorTarget: event.agent.vectorTarget,
          intensity: event.dynamics?.intensity || 0.5,
          hexColor: event.agent.hexColor,
        });
      }
    });

    // Wire agent feed → sprite spawn → impact → 3D stream
    onFeed((feedData) => {
      const sprite = spriteRef.current;
      if (!sprite || !rootRef.current) {
        if (brain) brain.injectFeed(feedData);
        return;
      }

      const rect = rootRef.current.getBoundingClientRect();
      const agentCard = rootRef.current.querySelector(`[data-agent-id="${feedData.agentId}"]`);

      let startVec;
      if (agentCard) {
        const cardRect = agentCard.getBoundingClientRect();
        startVec = { x: cardRect.right + 10, y: cardRect.top + cardRect.height / 2 };
      } else {
        startVec = { x: 180, y: 100 + Math.random() * 200 };
      }

      const targetVec = { x: rect.width / 2, y: rect.height / 2 };

      const SECTOR_COLORS = {
        PREFRONTAL: '#ff3b30', CONCEPT_LAYER: '#ff9500', HIPPOCAMPUS: '#4cd964',
        CEREBELLUM: '#5ac8fa', CONTEXT_CORTEX: '#22d3ee', TEMPORAL: '#f59e0b',
        PARIETAL: '#34d399', OCCIPITAL: '#818cf8',
      };
      const color = SECTOR_COLORS[feedData.targetSector] || '#ffffff';

      sprite.spawnMovingAgent(feedData.agentId, color, startVec, targetVec, feedData);
    });

    const interval = setInterval(async () => {
      const observations = await fetchObservations(50);
      if (observations.length > 0) {
        brain.updateObservations(observations);
        setStats({
          nodes: brain.nodeCount,
          edges: brain.edgeCount,
          active: brain.nodes.filter(n => n.glow > 0.5).length,
          particles: 5000 + brain.nodeCount
        });
      }
    }, 5000);

    return () => {
      clearInterval(interval);
      window.removeEventListener('synapse-impact', handleImpact);
      brain.destroy();
      if (spriteRef.current) spriteRef.current.destroy();
    };
  }, []);

  async function handleFeed() {
    if (!query.trim() || feeding) return;
    setFeeding(true);
    await feedBrain(query.trim());
    const obs = await fetchObservations(50);
    if (obs.length > 0 && sceneRef.current) {
      sceneRef.current.updateObservations(obs);
      setStats({
        nodes: sceneRef.current.nodeCount,
        edges: sceneRef.current.edgeCount,
        active: sceneRef.current.nodes.filter(n => n.glow > 0.5).length,
        particles: 5000 + sceneRef.current.nodeCount
      });
    }
    setQuery('');
    setFeeding(false);
  }

  return (
    <div ref={rootRef} style={{ width: '100%', height: '100%', position: 'relative', background: '#050508', overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />

      {/* Top bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 44,
        background: 'rgba(5, 5, 8, 0.92)',
        borderBottom: '1px solid rgba(255, 50, 50, 0.25)',
        display: 'flex', alignItems: 'center', padding: '0 20px', gap: 16,
        fontFamily: '"JetBrains Mono", "Fira Code", monospace', fontSize: 12,
        backdropFilter: 'blur(12px)'
      }}>
        <span style={{ color: '#ff4444', fontWeight: 700, letterSpacing: '0.1em' }}>SYPHER BRAIN</span>
        <span style={{ color: '#333' }}>|</span>
        <span style={{ color: '#666', letterSpacing: '0.05em', fontSize: 10 }}>NEUROLINK v3</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: connected ? '#4cd964' : '#ef4444', fontSize: 10, opacity: 0.8 }}>
          {connected ? `${agents.length} agents` : 'broker offline'}
        </span>
        <span style={{ color: '#333' }}>|</span>
        <span style={{ color: '#4a9eff', fontSize: 10, opacity: 0.8 }}>
          {stats.particles.toLocaleString()} particles
        </span>
        <span style={{ color: '#333' }}>|</span>
        <span style={{ color: '#34d399', fontSize: 10, opacity: 0.8 }}>
          {stats.active} active
        </span>
      </div>

      {/* Stats panel — top right */}
      <div style={{
        position: 'absolute', top: 60, right: 20,
        color: '#E5E7EB', fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
        background: 'rgba(5, 5, 8, 0.88)', padding: '14px 18px',
        borderRadius: 10, border: '1px solid rgba(100, 60, 180, 0.2)',
        backdropFilter: 'blur(16px)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)'
      }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <span><span style={{ color: '#34D399', fontWeight: 700 }}>{stats.nodes}</span> neurons</span>
          <span><span style={{ color: '#A78BFA', fontWeight: 700 }}>{stats.edges}</span> synapses</span>
          <span><span style={{ color: '#F59E0B', fontWeight: 700 }}>{stats.active}</span> firing</span>
        </div>
      </div>

      {/* Agent Grid — left panel */}
      <AgentGrid agents={agents} connected={connected} />

      {/* Category legend — bottom left */}
      <div style={{
        position: 'absolute', bottom: 80, left: 16,
        color: '#9CA3AF', fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
        display: 'flex', flexDirection: 'column', gap: 6
      }}>
        {Object.entries(NODE_COLORS).filter(([k]) => k !== 'default' && k !== 'stale').map(([type, color]) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%', background: color,
              boxShadow: `0 0 4px ${color}`
            }} />
            <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 8, color: '#555' }}>{type}</span>
          </div>
        ))}
      </div>

      {/* Feed input — terminal prompt */}
      <form onSubmit={(e) => { e.preventDefault(); handleFeed(); }} style={{
        position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
        width: 'min(600px, 90%)',
        background: 'rgba(5, 5, 10, 0.85)',
        border: '1px solid rgba(255, 255, 255, 0.05)',
        borderRadius: 6, padding: '12px 20px',
        display: 'flex', alignItems: 'center',
        backdropFilter: 'blur(20px)',
        boxShadow: '0 10px 40px rgba(0,0,0,0.8)',
        zIndex: 100,
      }}>
        <span style={{
          color: '#22d3ee', fontFamily: 'monospace', marginRight: 12, fontWeight: 'bold', fontSize: 14,
        }}>&#10095;</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={feeding ? "feeding neural network..." : "Feed the brain... type something"}
          disabled={feeding}
          style={{
            width: '100%', background: 'transparent', border: 'none', outline: 'none',
            color: '#fff', fontFamily: '"JetBrains Mono", "Courier New", monospace',
            fontSize: '0.9rem', letterSpacing: '0.5px',
          }}
        />
        <div style={{
          position: 'absolute', bottom: -1, left: '5%', width: '90%', height: 1,
          background: 'linear-gradient(90deg, transparent, #22d3ee, transparent)',
          opacity: feeding ? 0.9 : 0.4, transition: 'opacity 0.3s',
        }} />
      </form>

      {/* Hover tooltip */}
      {hoveredNode && (
        <div style={{
          position: 'absolute', bottom: 80, left: '50%', transform: 'translateX(-50%)',
          color: '#E5E7EB', fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
          background: 'rgba(5, 5, 8, 0.95)', padding: '12px 18px',
          borderRadius: 10, border: `1px solid ${hoveredNode.color || '#333'}`,
          maxWidth: 400, textAlign: 'center',
          boxShadow: `0 0 16px ${hoveredNode.color}33`,
          backdropFilter: 'blur(12px)'
        }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: hoveredNode.color }}>{hoveredNode.label}</div>
          <div style={{ opacity: 0.5, marginTop: 3, textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.1em' }}>{hoveredNode.category}</div>
          {hoveredNode.subtitle && <div style={{ opacity: 0.6, marginTop: 6, fontSize: 11 }}>{hoveredNode.subtitle}</div>}
        </div>
      )}

      {/* Controls hint */}
      <div style={{
        position: 'absolute', bottom: 24, right: 20,
        color: '#444', fontFamily: '"JetBrains Mono", monospace', fontSize: 9,
        textAlign: 'right', lineHeight: 1.8
      }}>
        orbit to rotate<br/>scroll to zoom<br/>click neurons
      </div>
    </div>
  );
}
