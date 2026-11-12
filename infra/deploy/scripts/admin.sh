#!/bin/sh
# Console admin recovery command inside the tools image, for when nobody can sign in to the Super Admin Console:
#   docker compose run --rm migrate /app/infra/deploy/scripts/admin.sh list
#   docker compose run --rm migrate /app/infra/deploy/scripts/admin.sh reset-mfa --email ops@sampledge.com
# Commands: list, create, reset-password, reset-mfa, unlock, set-role, disable, enable (see packages/db/scripts/platform-admin.ts).
# The migrate service already has MONGODB_URL set to the admin connection. Every change goes to the platform audit trail.
set -eu
cd /app/db
exec ./node_modules/.bin/tsx scripts/platform-admin.ts "$@"
