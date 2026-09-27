#!/usr/bin/env bash
# Quadri Music Studio installer for Linux: Python + PyTorch, YuE2 models (~8 GB), lyrics LLM (~5 GB), web UI.
# Everything goes into this folder. Safe to re-run: finished steps are skipped, downloads resume.
# Options: ./install.sh --help
set -euo pipefail
cd "$(dirname "$0")"

NODE_VERSION=v24.18.0

# Node.js ≥ 23.6 runs the TypeScript sources directly
node_ok() { "$1" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 23 || (a === 23 && b >= 6) ? 0 : 1)' 2>/dev/null; }

NODE=runtime/node/bin/node
if ! node_ok "$NODE"; then
  if command -v node >/dev/null && node_ok node; then
    NODE=node
  else
    [ "$(uname -m)" = x86_64 ] || { echo "Only x86-64 is supported (this is $(uname -m))." >&2; exit 1; }
    command -v curl >/dev/null || { echo "Please install curl first." >&2; exit 1; }
    echo "Downloading Node.js $NODE_VERSION (portable, into runtime/node)…"
    rm -rf runtime/node runtime/node.tmp && mkdir -p runtime/node.tmp
    curl -fL --progress-bar "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.gz" | tar -xz -C runtime/node.tmp --strip-components=1
    mv runtime/node.tmp runtime/node
  fi
fi

exec "$NODE" scripts/install.ts "$@"
