#!/bin/bash
# Entrypoint and health check of the bundled MongoDB in compose.yml: a one-node replica set (SampCrew relies on
# multi-document transactions, which need one) with authentication on.
#
#   mongo-start.sh            writes the replica set key file and starts mongod; on the first start the image
#                             creates the root user from MONGO_INITDB_ROOT_USERNAME / MONGO_INITDB_ROOT_PASSWORD
#   mongo-start.sh --health   starts the replica set the first time it is called, then succeeds once this node
#                             is primary and accepts writes
set -euo pipefail
if [ "${1:-}" = "--health" ]; then
  exec mongosh --quiet --host 127.0.0.1 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval '
    try { rs.status(); } catch (e) {
      if (e.codeName !== "NotYetInitialized") throw e;
      rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongo:27017" }] });
    }
    if (!db.hello().isWritablePrimary) quit(1);' >/dev/null
fi
: "${MONGO_REPLICA_KEY:?MONGO_REPLICA_KEY is required (run gen-secrets.sh)}"
key=/data/configdb/replica.key
( umask 077; printf '%s' "$MONGO_REPLICA_KEY" > "$key" )
chown mongodb:mongodb "$key" 2>/dev/null || true
chmod 400 "$key"
unset MONGO_REPLICA_KEY
exec docker-entrypoint.sh mongod --replSet rs0 --keyFile "$key" --bind_ip_all
