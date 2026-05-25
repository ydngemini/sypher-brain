#!/bin/bash
# SYPHER Brain — Remove Shell Telemetry Hook

HOOK_MARKER="# >>> SYPHER BRAIN TELEMETRY >>>"
HOOK_END="# <<< SYPHER BRAIN TELEMETRY <<<"

remove_hook() {
    local PROFILE="$1"
    if [[ ! -f "$PROFILE" ]]; then return; fi

    if grep -q "$HOOK_MARKER" "$PROFILE"; then
        sed -i "/$HOOK_MARKER/,/$HOOK_END/d" "$PROFILE"
        echo "  [done] Removed from $PROFILE"
    else
        echo "  [skip] Not found in $PROFILE"
    fi
}

echo "SYPHER Brain — Removing Telemetry Hook"
echo ""

remove_hook "$HOME/.bashrc"
remove_hook "$HOME/.zshrc"

echo ""
echo "Hook removed. Source your shell to apply."
