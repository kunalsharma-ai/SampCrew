#!/bin/sh
# Applies database migrations (collections, validators, indexes), creates or updates the API's own database user
# (MONGODB_API_PASSWORD, read and write on the SampCrew database only), then syncs the feature catalogue and
# bootstraps the first Super Admin (CREW_BOOTSTRAP_ADMIN_EMAIL / CREW_BOOTSTRAP_ADMIN_PASSWORD, only when none
# exists). Every step is safe to repeat, so this runs before every API release. MONGODB_URL must be an admin user.
set -eu
cd /app/db
./node_modules/.bin/tsx scripts/migrate.ts
./node_modules/.bin/tsx scripts/seed.ts
