#!/bin/bash
# SYPHER Brain — Shell Telemetry Hook Installer
# Injects zero-lag UDP capture into the user's shell profile.

HOOK_MARKER="# >>> SYPHER BRAIN TELEMETRY >>>"
HOOK_END="# <<< SYPHER BRAIN TELEMETRY <<<"

HOOK_BLOCK=$(cat <<'HOOKEOF'
# >>> SYPHER BRAIN TELEMETRY >>>
_sypher_kernel_capture() {
    local LAST_STATUS=$?
    local UNTRIMMED_CMD=$(fc -ln -1 2>/dev/null)
    local CLEAN_CMD=$(echo "$UNTRIMMED_CMD" | sed -e 's/^[ \t]*//' -e 's/"/\\"/g')
    local TIMESTAMP=$(date +%s)

    # Block empty, recursive, or internal commands
    if [[ -z "$CLEAN_CMD" || "$CLEAN_CMD" == *"sypher"* || "$CLEAN_CMD" == "_sypher"* ]]; then
        return
    fi

    # Non-blocking UDP dispatch via bash /dev/udp (no fork, no subshell wait)
    (echo "{\"cmd\":\"$CLEAN_CMD\",\"status\":$LAST_STATUS,\"time\":$TIMESTAMP,\"pwd\":\"$PWD\"}" > /dev/udp/127.0.0.1/3456) 2>/dev/null &
    disown 2>/dev/null
}

case "$PROMPT_COMMAND" in
    *_sypher_kernel_capture*) ;;
    *) PROMPT_COMMAND="_sypher_kernel_capture;${PROMPT_COMMAND:-:}" ;;
esac
# <<< SYPHER BRAIN TELEMETRY <<<
HOOKEOF
)

install_hook() {
    local PROFILE="$1"

    if [[ ! -f "$PROFILE" ]]; then
        echo "  [skip] $PROFILE does not exist"
        return
    fi

    if grep -q "$HOOK_MARKER" "$PROFILE" 2>/dev/null; then
        echo "  [ok]   $PROFILE already has hook"
        return
    fi

    echo "" >> "$PROFILE"
    echo "$HOOK_BLOCK" >> "$PROFILE"
    echo "  [done] Installed into $PROFILE"
}

echo "SYPHER Brain — Installing Telemetry Hook"
echo "Target: UDP 127.0.0.1:3456 (non-blocking)"
echo ""

install_hook "$HOME/.bashrc"
install_hook "$HOME/.zshrc"

echo ""
echo "Hook installed. Source your shell or open a new terminal."
echo "  source ~/.bashrc"
