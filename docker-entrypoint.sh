#!/bin/sh
# Fly mounts the volume root-owned; hand it to the unprivileged user, then
# drop privileges before starting the server.
set -eu
if [ -d /data ]; then
  chown -R node:node /data
fi
exec setpriv --reuid=node --regid=node --init-groups "$@"
