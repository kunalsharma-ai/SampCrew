#!/usr/bin/env bash
# Starts a one-node MongoDB 8.0 replica set (SampCrew relies on transactions, which need a replica set) on
# localhost:27017 in Docker and waits until it accepts writes. Used by CI; handy on a laptop too.
set -euo pipefail
name="${MONGO_CONTAINER:-mongo}"
# mongo:8.0 refuses to start on Linux 6.19+ (SERVER-121912). Turning off tcmalloc's rseq use lets it run (docker-library/mongo#765).
docker run -d --name "$name" -p 27017:27017 -e GLIBC_TUNABLES=glibc.pthread.rseq=1 mongo:8.0 mongod --replSet rs0 --bind_ip_all >/dev/null
ready() { docker exec "$name" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; }
for _ in $(seq 1 60); do ready && break; sleep 1; done
# Show why mongod stopped or never answered, instead of failing on the next command with no clue.
ready || { docker ps -a --filter "name=$name"; docker logs "$name" 2>&1 | tail -80; exit 1; }
docker exec "$name" mongosh --quiet --eval 'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] })' >/dev/null
primary() { [ "$(docker exec "$name" mongosh --quiet --eval 'db.hello().isWritablePrimary')" = "true" ]; }
for _ in $(seq 1 60); do primary && break; sleep 1; done
primary || { docker logs "$name" 2>&1 | tail -80; exit 1; }
echo "MongoDB replica set rs0 is ready on localhost:27017"
