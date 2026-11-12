#!/bin/bash
# Entrypoint and health check of the bundled MongoDB in compose.yml: a one-node replica set (SampCrew relies on
# multi-document transactions, which need one) with authentication on.
#
#   mongo-start.sh            writes the replica set key file and starts mongod; on the first start the image
#                             creates the root user from MONGO_INITDB_ROOT_USERNAME / MONGO_INITDB_ROOT_PASSWORD
#   mongo-start.sh --health   starts the replica set the first time it is called, then succeeds once this node
#                             is primary and accepts writes
#
# Settings (compose.yml passes them from .env):
#   MONGO_REPLICA_HOST     the address this member announces to the replica set (default mongo:27017). Set it to a
#                          name the other servers can reach before the first start if you will add members later.
#   MONGO_CACHE_SIZE_GB    WiredTiger cache size. Default: MongoDB's own (half of the memory minus 1 GB), which is
#                          too much when the API and the apps share the host; 2 is right for the 8 GB host in the runbook.
set -euo pipefail
REPLICA_HOST="${MONGO_REPLICA_HOST:-mongo:27017}"
if [ "${1:-}" = "--health" ]; then
  export REPLICA_HOST
  exec mongosh --quiet --host 127.0.0.1 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval '
    try { rs.status(); } catch (e) {
      if (e.codeName !== "NotYetInitialized") throw e;
      rs.initiate({ _id: "rs0", members: [{ _id: 0, host: process.env.REPLICA_HOST }] });
    }
    if (!db.hello().isWritablePrimary) quit(1);' >/dev/null
fi
: "${MONGO_REPLICA_KEY:?MONGO_REPLICA_KEY is required (run gen-secrets.sh)}"
key=/data/configdb/replica.key
( umask 077; printf '%s' "$MONGO_REPLICA_KEY" > "$key" )
chown mongodb:mongodb "$key" 2>/dev/null || true
chmod 400 "$key"
unset MONGO_REPLICA_KEY
args=(--replSet rs0 --keyFile "$key" --bind_ip_all)
if [ -n "${MONGO_CACHE_SIZE_GB:-}" ]; then args+=(--wiredTigerCacheSizeGB "$MONGO_CACHE_SIZE_GB"); fi
exec docker-entrypoint.sh mongod "${args[@]}"
