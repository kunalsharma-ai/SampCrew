#!/bin/sh
# Applies database migrations (collections, validators, indexes), creates or updates the API's own database user
# (MONGODB_API_PASSWORD, read and write on the SampCrew database only), then syncs the feature catalogue and
# creates the first Super Admin only if CREW_BOOTSTRAP_ADMIN_EMAIL / _PASSWORD are set and none exists (unattended
# installs; normally it is created in the Console with the setup code from the API log). Every step is safe to repeat, so this runs before every API release. MONGODB_URL must be an admin user.
set -eu
cd /app/db
./node_modules/.bin/tsx scripts/migrate.ts
./node_modules/.bin/tsx scripts/seed.ts
