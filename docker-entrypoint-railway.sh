#!/bin/bash
# Railway entrypoint: fix volume permissions then drop to non-root user.
# The /data volume may be root-owned on first mount, so we chown it before
# starting the app. claude-code refuses --dangerously-skip-permissions as root.
set -e

chown -R node:node /data 2>/dev/null || true

exec gosu node "$@"
