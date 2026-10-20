#!/bin/sh
set -eu
# The OS releases this lock even after a forced container stop. Only the
# container entrypoint uses this volume; never run a second writer against it.
exec flock --exclusive --nonblock .local/container.lock sh -c '
  rm -f .local/business.lock
  exec node scripts/start-sandbox.js
'
