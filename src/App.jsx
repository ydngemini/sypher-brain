import { useEffect, useRef, useState } from 'react';
import { BrainScene } from './engine/scene.js';
import { feedBrain } from './graph/data-source.js';
import { NODE_COLORS } from './graph/color-scheme.js';
import { useBroker } from './agents/useBroker.js';
import { AgentSpriteManager } from './agents/AgentSpriteManager.js';
import AgentGrid from './agents/AgentGrid.jsx';
import ActionLog from './agents/ActionLog.jsx';
import NeuronDetail from './agents/NeuronDetail.jsx';
import './agents/AgentSprite.css';

export default function App() {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0, active: 0, particles: 5000, vault: 0, obs: 0 });
  const [hoveredNode, setHoveredNode] = useState(null);
  const [query, setQuery] = useState('');
  const [feeding, setFeeding] = useState(false);
  const [layer, setLayer] = useState('both'); // 'vault' | 'observations' | 'both'
  const [selection, setSelection] = useState(null); // { sceneNode, source }
  const {
    agents, feeds, connected,
    onFeed, onSynapse, onInit, onVaultNode, onVaultDelete, onObservation, onThought,
  } = useBroker();
  const spriteRef = useRef(null);
  const rootRef = useRef(null);

  function refreshStats() {
    const brain = sceneRef.current;
    if (!brain) return;
    setStats({
      nodes: brain.nodeCount,
      edges: brain.edgeCount,
      active: brain.nodes.filter(n => n.glow > 0.5).length,
      particles: 5000 + brain.nodeCount,
      vault: brain.vaultMap.size,
      obs: brain.obsMap.size,
    });
  }

  useEffect(() => {
    if (!canvasRef.current) return;

    const brain = new BrainScene(canvasRef.current);
    sceneRef.current = brain;
    brain.onHover = (node) => setHoveredNode(node);
    brain.onSelect = (sel) => setSelection(sel);

    // When the brain forms a semantic synapse between two VAULT notes, push
    // it to the broker. vault-writer subscribes and writes the [[wikilink]]
    // into the actual .md file — Obsidian then sees the same connection.
    brain.onVaultSynapse = (info) => {
      fetch('http://127.0.0.1:9800/api/vault-synapse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(info),
      }).catch(() => {});
    };

    if (rootRef.current && !spriteRef.current) {
      spriteRef.current = new AgentSpriteManager(rootRef.current);
    }

    // INIT seed — broker gives us full vault + recent observations on connect
    onInit((data) => {
      if (data.vaultNodes?.length) brain.loadVaultBulk(data.vaultNodes);
      if (data.observations?.length) brain.loadObservations(data.observations);
      requestAnimationFrame(refreshStats);
    });

    onVaultNode((node) => {
      brain.addOrUpdateVaultNode(node);
      requestAnimationFrame(refreshStats);
    });

    onVaultDelete(({ id }) => {
      brain.removeVaultNode(id);
      requestAnimationFrame(refreshStats);
    });

    onObservation((obs) => {
      brain.appendObservation(obs);
      requestAnimationFrame(refreshStats);
    });

    // When agent-mind delivers a generated thought, swap the walker's bubble
    onThought(({ feedId, thought }) => {
      if (spriteRef.current) spriteRef.current.updateBubbleForFeed(feedId, thought);
    });

    const handleImpact = (e) => {
      if (brain && e.detail.feedData) brain.injectFeed(e.detail.feedData);
    };
    window.addEventListener('synapse-impact', handleImpact);

    onSynapse((event) => {
      if (brain && event.agent) {
        brain.instancedStreams.inject({
          vectorTarget: event.agent.vectorTarget,
          intensity: event.dynamics?.intensity || 0.5,
          hexColor: event.agent.hexColor,
        });
      }
    });

    onFeed((feedData) => {
      // Grow one real neuron in the brain for every broker feed. The neuron
      // carries the event metadata, is positioned inside the brain shell, and
      // forms synapses for any synapticAssociations whose endpoints match
      // existing real neurons.
      if (brain) brain.growFromFeed(feedData);

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
        CEREBELLUM: '#e633b4', SENSORY_CORTEX: '#00e5f0', TEMPORAL: '#f59e0b',
        PARIETAL: '#34d399', OCCIPITAL: '#818cf8',
      };
      const color = SECTOR_COLORS[feedData.targetSector] || '#ffffff';

      sprite.spawnMovingAgent(feedData.agentId, color, startVec, targetVec, feedData);
    });

    // periodic stats refresh (cheap — no polling, just UI)
    const statsTick = setInterval(refreshStats, 2000);

    return () => {
      clearInterval(statsTick);
      window.removeEventListener('synapse-impact', handleImpact);
      brain.destroy();
      if (spriteRef.current) spriteRef.current.destroy();
    };
  }, [onFeed, onSynapse, onInit, onVaultNode, onVaultDelete, onObservation, onThought]);

  // Apply layer filter to scene whenever the toggle changes
  useEffect(() => {
    const brain = sceneRef.current;
    if (!brain) return;
    brain.setLayerFilter({
      vault: layer === 'vault' || layer === 'both',
      observations: layer === 'observations' || layer === 'both',
    });
    requestAnimationFrame(refreshStats);
  }, [layer]);

  async function handleFeed() {
    if (!query.trim() || feeding) return;
    setFeeding(true);
    await feedBrain(query.trim());
    setQuery('');
    setFeeding(false);
    // No need to re-poll — broker tailer will push OBSERVATION_NEW within ~1s
  }

  const layerButton = (value, label) => (
    <button
      type="button"
      onClick={() => setLayer(value)}
      style={{
        background: layer === value ? 'rgba(74, 158, 255, 0.18)' : 'transparent',
        border: layer === value ? '1px solid rgba(74, 158, 255, 0.55)' : '1px solid rgba(255,255,255,0.07)',
        color: layer === value ? '#9dc4ff' : '#666',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 10,
        letterSpacing: '0.08em',
        padding: '4px 10px',
        borderRadius: 4,
        cursor: 'pointer',
        textTransform: 'uppercase',
      }}
    >
      {label}
    </button>
  );

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

        <div style={{ display: 'flex', gap: 4, marginLeft: 12 }}>
          {layerButton('vault', `vault · ${stats.vault}`)}
          {layerButton('observations', `obs · ${stats.obs}`)}
          {layerButton('both', 'both')}
        </div>

        <div style={{ flex: 1 }} />
        <span style={{ color: '#34D399', fontSize: 10, opacity: 0.85 }}>
          {stats.nodes} neurons
        </span>
        <span style={{ color: '#333' }}>|</span>
        <span style={{ color: '#A78BFA', fontSize: 10, opacity: 0.85 }}>
          {stats.edges} synapses
        </span>
        <span style={{ color: '#333' }}>|</span>
        <span style={{ color: '#F59E0B', fontSize: 10, opacity: 0.85 }}>
          {stats.active} firing
        </span>
        <span style={{ color: '#333' }}>|</span>
        <span style={{ color: connected ? '#4cd964' : '#ef4444', fontSize: 10, opacity: 0.85 }}>
          {connected ? `${agents.length} agents` : 'broker offline'}
        </span>
      </div>

      {/* Agent Grid — left panel (now includes live sparklines + payload tickers) */}
      <AgentGrid agents={agents} feeds={feeds} connected={connected} />

      {/* Live action log OR neuron detail (mutually exclusive on the right side) */}
      {selection
        ? <NeuronDetail selection={selection} onClose={() => setSelection(null)} />
        : <ActionLog feeds={feeds} />
      }

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
