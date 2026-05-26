#!/bin/bash
# SYPHER Brain — Full Stack Supervisor
# Spawns embed-server, broker (UDP+HTTP+WS+ambient pulses), vault bridge, and Vite.
# Each service runs in a restart loop so the stack is always-on.
#
# Logs:   $DIR/logs/<service>.log
# Stop:   Ctrl-C, or `pkill -f sypher-brain/start.sh`
# Status: `pgrep -af sypher-brain` or `ss -tlnp | grep -E ':(5174|5175|9800)'`

DIR="$(cd "$(dirname "$0")" && pwd)"
LOGS="$DIR/logs"
mkdir -p "$LOGS"

if [ -f "$DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$DIR/.env"
    set +a
fi

PIDS=()

LLAMA_BIN="/media/ydn/SYPHER_CORE/Untitled Folder/llama.cpp/build/bin/llama-server"
LLAMA_MODEL="/media/ydn/SYPHER_CORE/models/Llama-3.2-1B-Instruct-Q4_K_M.gguf"

cat <<'BANNER'
╔══════════════════════════════════════════════╗
║         SYPHER BRAIN — NEURAL CORE           ║
╠══════════════════════════════════════════════╣
║  Embed Server : http://127.0.0.1:5175        ║
║  Broker HTTP  : http://127.0.0.1:9800        ║
║  Broker UDP   : udp://127.0.0.1:3456         ║
║  Vault Bridge : SYPHER_VAULT → broker        ║
║  Llama Server : http://127.0.0.1:8090        ║
║  Agent Mind   : llama → broker thoughts      ║
║  Brain Viz    : http://localhost:5174        ║
║  Mode         : auto-restart supervisor      ║
╚══════════════════════════════════════════════╝
BANNER

supervise() {
    local name="$1"
    shift
    local log="$LOGS/$name.log"
    (
        while true; do
            echo "[$(date '+%H:%M:%S')] [supervisor] starting $name: $*" | tee -a "$log"
            "$@" >>"$log" 2>&1
            local code=$?
            echo "[$(date '+%H:%M:%S')] [supervisor] $name exited (code=$code), restart in 2s" | tee -a "$log"
            sleep 2
        done
    ) &
    PIDS+=($!)
    echo "[supervisor] $name → pid $! (log: $log)"
}

# Each service runs forever, restarted on crash with 2s backoff
supervise embed-server   "$DIR/.venv/bin/python" "$DIR/embed-server.py"
supervise broker         node "$DIR/src/agents/broker.js"
supervise vault-bridge   node "$DIR/src/agents/mcp-bridge.js"
supervise vite           bash -c "cd '$DIR' && npx vite --host"

# llama-server only starts if the binary exists; otherwise the agent-mind
# service will keep polling until it does.
if [ -x "$LLAMA_BIN" ] && [ -f "$LLAMA_MODEL" ]; then
    # --no-repack    : skip CPU weight repacking (saves ~450MB, costs ~10% speed)
    # --cache-ram 64 : prompt cache enabled with tight 64MB budget (massive
    #                  speedup on repeated system prompts; cached at ~10ms vs 3s cold)
    # -c 1024        : context window — enough for persona + 8-feed memory
    # -t 3           : leave 1 core for browser + brain rendering
    supervise llama-server "$LLAMA_BIN" -m "$LLAMA_MODEL" \
        --host 127.0.0.1 --port 8090 \
        -c 1024 -t 3 --no-repack --cache-ram 64 --no-warmup
else
    echo "[supervisor] llama-server skipped (missing binary or model)"
    echo "             bin:   $LLAMA_BIN"
    echo "             model: $LLAMA_MODEL"
fi

supervise agent-mind     node "$DIR/src/agents/agent-mind.js"
supervise vault-writer   node "$DIR/src/agents/vault-writer.js"
supervise transcript-watcher node "$DIR/src/agents/transcript-watcher.js"

cleanup() {
    echo ""
    echo "[supervisor] shutdown — killing ${#PIDS[@]} supervised loops"
    for pid in "${PIDS[@]}"; do
        kill -- -"$pid" 2>/dev/null
        kill "$pid" 2>/dev/null
    done
    # Also kill any direct service children
    pkill -P $$ 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

wait
