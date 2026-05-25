"""
SYPHER Brain — Claude Agent Worker
Wraps Claude CLI output, extracts NEURAL_FEED JSON blocks,
and pushes them to the broker via HTTP POST.

Usage:
  python claude_worker.py --agent-id "developer_01" --role "Developer"

The worker monitors stdin for NEURAL_FEED JSON blocks and forwards them.
Can also be imported and used programmatically.
"""
import argparse
import json
import re
import sys
import urllib.request
from datetime import datetime

BROKER_URL = "http://127.0.0.1:9800/api/feed"
NEURAL_FEED_PATTERN = re.compile(
    r'\{[^{}]*"agentId"[^{}]*"targetSector"[^{}]*"intensity"[^{}]*\}',
    re.DOTALL
)


def post_feed(feed_data: dict) -> bool:
    try:
        payload = json.dumps(feed_data).encode()
        req = urllib.request.Request(
            BROKER_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except Exception as e:
        print(f"[worker] Failed to post feed: {e}", file=sys.stderr)
        return False


def extract_neural_feeds(text: str) -> list[dict]:
    feeds = []
    for match in NEURAL_FEED_PATTERN.finditer(text):
        try:
            obj = json.loads(match.group())
            if all(k in obj for k in ("agentId", "targetSector", "intensity")):
                feeds.append(obj)
        except json.JSONDecodeError:
            continue
    return feeds


def create_feed(agent_id: str, target_sector: str, intensity: float,
                associations: list[dict] = None, summary: str = "") -> dict:
    return {
        "agentId": agent_id,
        "targetSector": target_sector,
        "intensity": max(0.0, min(1.0, intensity)),
        "synapticAssociations": associations or [],
        "payloadSummary": summary,
    }


def monitor_stdin(agent_id: str):
    print(f"[worker] Monitoring stdin for NEURAL_FEED blocks (agent: {agent_id})")
    buffer = ""

    for line in sys.stdin:
        buffer += line
        feeds = extract_neural_feeds(buffer)
        if feeds:
            for feed in feeds:
                feed["agentId"] = agent_id
                if post_feed(feed):
                    print(f"[worker] Posted: {feed['targetSector']} ({feed['intensity']:.2f})")
            buffer = ""
        elif len(buffer) > 10000:
            buffer = buffer[-2000:]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SYPHER Brain Agent Worker")
    parser.add_argument("--agent-id", default="claude_default", help="Agent identifier")
    parser.add_argument("--role", default="Developer", help="Agent role")
    args = parser.parse_args()

    print(f"[worker] SYPHER Brain Agent Worker")
    print(f"[worker] Agent: {args.agent_id} | Role: {args.role}")
    print(f"[worker] Broker: {BROKER_URL}")
    monitor_stdin(args.agent_id)
