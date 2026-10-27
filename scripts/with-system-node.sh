#!/bin/bash
# Run npm/node against the deployment's Node so native modules match PM2.
# The historical wrapper name is retained; custom Node installations work too.
#
# Usage:
#   ./scripts/with-system-node.sh npm rebuild
#   ./scripts/with-system-node.sh npm install better-sqlite3 --build-from-source
#   PATH=/usr/bin:$PATH npm rebuild   (equivalent one-liner)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/node-runtime.sh"
metabot_select_node "${METABOT_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}" || exit 1
exec "$@"
