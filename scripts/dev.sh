#!/usr/bin/env bash
# Starts the web app locally in mock mode (docs/CONTRACTS.md §4): the whole UI runs on an in-memory
# mock API with a fake signed-in owner, so no AWS account or config.json is needed.
# Extra arguments are passed to Vite, e.g. `scripts/dev.sh --host` to open it from a phone on the same Wi-Fi.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}/web"

command -v npm >/dev/null || { echo "dev.sh: Node.js 24 with npm is required (https://nodejs.org)" >&2; exit 1; }

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 24 ]; then
  echo "dev.sh: warning: Node.js ${node_major} found; CI uses Node.js 24." >&2
fi

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  npm ci
fi

if [ "$#" -gt 0 ]; then
  exec npm run dev:mock -- "$@"
fi
exec npm run dev:mock
