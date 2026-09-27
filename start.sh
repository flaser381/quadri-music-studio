#!/usr/bin/env bash
# Starts Quadri Music Studio and opens it in the browser (http://localhost:8096).
# The studio loads YuE2 and the lyrics LLM itself when needed. Ctrl+C stops everything.
set -euo pipefail
cd "$(dirname "$0")"

[ -f runtime/installed ] || ./install.sh

node_ok() { "$1" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 23 || (a === 23 && b >= 6) ? 0 : 1)' 2>/dev/null; }
NODE=runtime/node/bin/node
node_ok "$NODE" || NODE=node

export STUDIO_OPEN="${STUDIO_OPEN:-1}"
exec "$NODE" backend/src/index.ts
