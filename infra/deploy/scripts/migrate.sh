#!/bin/sh
# Applies database migrations, then syncs the feature catalogue and bootstraps the first Super Admin
# (CREW_BOOTSTRAP_ADMIN_EMAIL / CREW_BOOTSTRAP_ADMIN_PASSWORD, only when none exists). Both steps are safe to repeat,
# so this runs before every API release. Needs DATABASE_ADMIN_URL and DATABASE_API_PASSWORD.
set -eu
cd /app/db
./node_modules/.bin/tsx scripts/migrate.ts
./node_modules/.bin/tsx scripts/seed.ts
