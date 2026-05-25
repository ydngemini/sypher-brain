const CLAUDE_MEM_API = 'http://127.0.0.1:37777';

export async function fetchObservations(limit = 200) {
  try {
    const res = await fetch(`${CLAUDE_MEM_API}/api/observations?limit=${limit}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : data.items || data.observations || [];
  } catch {
    return [];
  }
}

export async function feedBrain(content) {
  try {
    const res = await fetch(`${CLAUDE_MEM_API}/api/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: content.slice(0, 80),
        content: content,
        type: 'discovery',
        source: 'brain-feed'
      })
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function searchObservations(query) {
  try {
    const res = await fetch(`${CLAUDE_MEM_API}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 20 })
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : data.items || data.results || [];
  } catch {
    return [];
  }
}
