#!/bin/bash
# SYPHER Brain — Full Stack Launcher
# Starts: Embed Server (5175) + Broker Daemon (9800/UDP:3456) + Vite Dev (5174)

DIR="$(cd "$(dirname "$0")" && pwd)"

# Load environment (API keys, ports)
if [ -f "$DIR/.env" ]; then
    set -a
    source "$DIR/.env"
    set +a
fi

echo "╔══════════════════════════════════════════════╗"
echo "║         SYPHER BRAIN — NEURAL CORE           ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Embed Server : http://127.0.0.1:5175       ║"
echo "║  Broker HTTP  : http://127.0.0.1:9800       ║"
echo "║  Broker UDP   : udp://127.0.0.1:3456        ║"
echo "║  MCP Bridge   : SYPHER_VAULT → broker       ║"
echo "║  Brain Viz    : http://localhost:5174        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Start embed server
"$DIR/.venv/bin/python" "$DIR/embed-server.py" &
EMBED_PID=$!

# Start broker daemon (UDP + HTTP + WS)
node "$DIR/src/agents/broker.js" &
BROKER_PID=$!

# Start MCP vault bridge (watches Obsidian vault for mutations)
node "$DIR/src/agents/mcp-bridge.js" &
MCP_PID=$!

# Start Vite dev server
cd "$DIR" && npx vite &
VITE_PID=$!

trap "kill $EMBED_PID $BROKER_PID $MCP_PID $VITE_PID 2>/dev/null; exit" SIGINT SIGTERM

wait
