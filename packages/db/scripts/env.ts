export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing environment variable ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

/** Migrations and seeds connect with the admin (owner) URL, never the API's restricted role. */
export const adminUrl = () => requireEnv('DATABASE_ADMIN_URL');
