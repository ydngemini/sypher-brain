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
  const mutationCallbackRef = useRef(null);

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

  const onFeed = useCallback((cb) => {
    feedCallbackRef.current = cb;
  }, []);

  const onSynapse = useCallback((cb) => {
    synapseCallbackRef.current = cb;
  }, []);

  const sendFeed = useCallback(async (feed) => {
    try {
      await fetch(`${BROKER_HTTP}/api/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feed),
      });
    } catch {}
  }, []);

  return { agents, feeds, connected, onFeed, onSynapse, sendFeed };
}
