#!/bin/bash
# SYPHER Brain — Claude CLI hook
#
# Wired into Claude Code's PreToolUse / PostToolUse / UserPromptSubmit / Stop
# events via ~/.claude/settings.json. Every time Claude reads, writes, runs
# bash, plans, delegates, browses, or completes a turn — and every time the
# user submits a prompt — this script posts a NEURAL_FEED to the broker so
# the brain renders the activity in real time.
#
# Usage from settings.json hook config:
#   command: /media/ydn/SYPHER_CORE/sypher-brain/hooks/claude-brain-hook.sh <event>
# where <event> is one of: pre | post | prompt | stop
#
# IMPORTANT: must exit 0 quickly. Any failure here would block Claude tool
# calls. We never propagate errors — broker offline => silent no-op.

set +e
EVENT="${1:-unknown}"
PAYLOAD=$(cat 2>/dev/null || true)
BROKER="${BROKER_HTTP:-http://127.0.0.1:9800}"

# jq is required for safe JSON parsing — if missing, exit silently
if ! command -v jq >/dev/null 2>&1; then exit 0; fi

# Extract tool + a short summary of what's being done, per event type
case "$EVENT" in
  pre)
    TOOL=$(echo "$PAYLOAD" | jq -r '.tool_name // "unknown"' 2>/dev/null)
    case "$TOOL" in
      Read|Grep|Glob|NotebookRead)
        AGENT="CLAUDE_READER"; SECTOR="OCCIPITAL"; INTENSITY=0.55 ;;
      Write|Edit|NotebookEdit)
        AGENT="CLAUDE_WRITER"; SECTOR="PREFRONTAL"; INTENSITY=0.85 ;;
      Bash)
        AGENT="CLAUDE_KERNEL"; SECTOR="CEREBELLUM"; INTENSITY=0.7 ;;
      TaskCreate|TaskUpdate|TaskList|TaskGet)
        AGENT="CLAUDE_PLANNER"; SECTOR="PREFRONTAL"; INTENSITY=0.6 ;;
      AskUserQuestion)
        AGENT="CLAUDE_DIALOGUE"; SECTOR="SENSORY_CORTEX"; INTENSITY=0.55 ;;
      Agent|TaskCreate)
        AGENT="CLAUDE_DELEGATOR"; SECTOR="CONCEPT_LAYER"; INTENSITY=0.75 ;;
      WebFetch|WebSearch)
        AGENT="CLAUDE_BROWSER"; SECTOR="SENSORY_CORTEX"; INTENSITY=0.65 ;;
      ScheduleWakeup|Monitor|Skill)
        AGENT="CLAUDE_CONTROL"; SECTOR="HIPPOCAMPUS"; INTENSITY=0.45 ;;
      *)
        AGENT="CLAUDE_HAND"; SECTOR="PREFRONTAL"; INTENSITY=0.5 ;;
    esac
    # A short, real summary of the action
    SUMMARY=$(echo "$PAYLOAD" | jq -r '
      .tool_name + " " + (
        .tool_input.file_path
        // .tool_input.command
        // .tool_input.pattern
        // .tool_input.url
        // .tool_input.query
        // .tool_input.subject
        // .tool_input.old_string[:60]?
        // .tool_input.skill
        // ""
      )
    ' 2>/dev/null | head -c 80)
    ;;
  post)
    TOOL=$(echo "$PAYLOAD" | jq -r '.tool_name // "?"' 2>/dev/null)
    AGENT="CLAUDE_RESPONDER"; SECTOR="TEMPORAL"; INTENSITY=0.4
    SUMMARY="finished ${TOOL}"
    ;;
  prompt)
    AGENT="USER_INTENT"; SECTOR="SENSORY_CORTEX"; INTENSITY=0.95
    SUMMARY=$(echo "$PAYLOAD" | jq -r '.prompt // ""' 2>/dev/null | head -c 100 | tr '\n' ' ')
    ;;
  stop)
    AGENT="CLAUDE_CYCLE"; SECTOR="TEMPORAL"; INTENSITY=0.5
    SUMMARY="turn complete"
    ;;
  *)
    AGENT="CLAUDE_SIGNAL"; SECTOR="PREFRONTAL"; INTENSITY=0.3
    SUMMARY="$EVENT"
    ;;
esac

# Default summary fallback
[ -z "$SUMMARY" ] && SUMMARY="$EVENT"

# Build JSON safely with jq (handles special chars in SUMMARY)
BODY=$(jq -nc \
  --arg agent "$AGENT" \
  --arg sector "$SECTOR" \
  --arg summary "$SUMMARY" \
  --argjson intensity "$INTENSITY" \
  '{agentId:$agent, targetSector:$sector, intensity:$intensity, payloadSummary:$summary, synapticAssociations:[]}')

# Fire and forget — short timeout so we never block Claude
curl -s -m 1 -X POST "$BROKER/api/feed" \
  -H 'content-type: application/json' \
  -d "$BODY" >/dev/null 2>&1 &

exit 0
