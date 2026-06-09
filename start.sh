#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

NODE_DIR=".tools/node"
NODE_FALLBACK=".tools/node-v20.19.0-darwin-arm64"
NODE_BIN="$NODE_DIR/bin"

find_node() {
  if command -v npm >/dev/null 2>&1; then
    echo "$(dirname "$(command -v npm)")"
    return 0
  fi
  for p in /opt/homebrew/bin /usr/local/bin \
    "$HOME/.nvm/versions/node/"*/bin \
    "$HOME/.fnm/node-versions/"*/installation/bin; do
    if [ -x "$p/npm" ]; then
      echo "$p"
      return 0
    fi
  done
  if [ -x "$NODE_BIN/npm" ]; then
    echo "$NODE_BIN"
    return 0
  fi
  if [ -x "$NODE_FALLBACK/bin/npm" ]; then
    echo "$NODE_FALLBACK/bin"
    return 0
  fi
  return 1
}

install_portable_node() {
  echo "Node.js not found — downloading portable Node 20…"
  mkdir -p .tools
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64) TAR="node-v20.19.0-darwin-arm64.tar.gz" ;;
    x86_64) TAR="node-v20.19.0-darwin-x64.tar.gz" ;;
    *) echo "Unsupported arch: $ARCH"; exit 1 ;;
  esac
  URL="https://nodejs.org/dist/v20.19.0/$TAR"
  curl -fsSL "$URL" -o ".tools/$TAR"
  rm -rf "$NODE_DIR"
  tar -xzf ".tools/$TAR" -C .tools
  EXTRACTED="$(ls -d .tools/node-v20.19.0-darwin-* 2>/dev/null | head -1)"
  rm -rf "$NODE_DIR"
  mv "$EXTRACTED" "$NODE_DIR"
  rm -f ".tools/$TAR"
}

BIN_DIR="$(find_node)" || { install_portable_node; BIN_DIR="$(find_node)"; }
export PATH="$BIN_DIR:$PATH"

if [ ! -d node_modules ]; then
  npm install
fi
if [ -x python/start_analyzer.sh ] && command -v python3 >/dev/null 2>&1; then
  if ! curl -fsS "http://127.0.0.1:8787/health" >/dev/null 2>&1; then
    echo "Starting Python floor analyzer on :8787…"
    (./python/start_analyzer.sh &) 
    sleep 1
  fi
fi

echo "Starting NavMe 3D at http://127.0.0.1:5173"
exec npm run dev -- --host 127.0.0.1
