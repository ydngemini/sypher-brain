import { useEffect, useRef, useState, useCallback } from 'react';

const BROKER_WS = 'ws://127.0.0.1:9800';
const BROKER_HTTP = 'http://127.0.0.1:9800';

export function useBroker() {
  const wsRef = useRef(null);
  const [agents, setAgents] = useState([]);
  const [feeds, setFeeds] = useState([]);
  const [connected, setConnected] = useState(false);
  const feedCallbackRef = useRef(null);
  const synapseCallbackRef = useRef(null);
  const initCallbackRef = useRef(null);
  const vaultNodeCallbackRef = useRef(null);
  const vaultDeleteCallbackRef = useRef(null);
  const observationCallbackRef = useRef(null);
  const thoughtCallbackRef = useRef(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(BROKER_WS);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setTimeout(connect, 3000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'INIT') {
          setAgents(msg.data.agents || []);
          setFeeds(msg.data.feeds || []);
          if (initCallbackRef.current) initCallbackRef.current(msg.data);
        } else if (msg.type === 'NEURAL_FEED') {
          setFeeds(prev => [...prev.slice(-49), msg.data]);
          if (feedCallbackRef.current) feedCallbackRef.current(msg.data);
        } else if (msg.type === 'SYNAPSE_ACTIVATION') {
          if (synapseCallbackRef.current) synapseCallbackRef.current(msg);
        } else if (msg.type === 'AGENT_UPDATE') {
          setAgents(prev => {
            const idx = prev.findIndex(a => a.id === msg.data.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = msg.data;
              return next;
            }
            return [...prev, msg.data];
          });
        } else if (msg.type === 'VAULT_NODE') {
          if (vaultNodeCallbackRef.current) vaultNodeCallbackRef.current(msg.data);
        } else if (msg.type === 'VAULT_NODE_DELETE') {
          if (vaultDeleteCallbackRef.current) vaultDeleteCallbackRef.current(msg.data);
        } else if (msg.type === 'OBSERVATION_NEW') {
          if (observationCallbackRef.current) observationCallbackRef.current(msg.data);
        } else if (msg.type === 'AGENT_THOUGHT') {
          if (thoughtCallbackRef.current) thoughtCallbackRef.current(msg.data);
        }
      } catch {}
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const onFeed = useCallback((cb) => { feedCallbackRef.current = cb; }, []);
  const onSynapse = useCallback((cb) => { synapseCallbackRef.current = cb; }, []);
  const onInit = useCallback((cb) => { initCallbackRef.current = cb; }, []);
  const onVaultNode = useCallback((cb) => { vaultNodeCallbackRef.current = cb; }, []);
  const onVaultDelete = useCallback((cb) => { vaultDeleteCallbackRef.current = cb; }, []);
  const onObservation = useCallback((cb) => { observationCallbackRef.current = cb; }, []);
  const onThought = useCallback((cb) => { thoughtCallbackRef.current = cb; }, []);

  const sendFeed = useCallback(async (feed) => {
    try {
      await fetch(`${BROKER_HTTP}/api/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feed),
      });
    } catch {}
  }, []);

  return {
    agents,
    feeds,
    connected,
    onFeed,
    onSynapse,
    onInit,
    onVaultNode,
    onVaultDelete,
    onObservation,
    onThought,
    sendFeed,
  };
}
