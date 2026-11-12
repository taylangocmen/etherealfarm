#!/bin/sh
set -eu
repo_root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
node_binary=${ETHEREALFARM_NODE:-$(command -v node)}
cd "$repo_root"
exec /usr/bin/sandbox-exec -f "$repo_root/headless/rl/offline.sb" \
  "$repo_root/.venv-rl/bin/python" -m headless.rl_v2.train --node "$node_binary" "$@"
