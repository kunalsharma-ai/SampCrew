import { join } from 'node:path';
import type { NextConfig } from 'next';

// Container images build with NEXT_OUTPUT=standalone: a self-contained server with only the files it needs.
const standalone = process.env.NEXT_OUTPUT === 'standalone';

// The Content Security Policy is set per request in middleware.ts, because it carries a fresh script nonce.

const config: NextConfig = {
  transpilePackages: ['@crew/ui'],
  poweredByHeader: false,
  ...(standalone ? { output: 'standalone' as const, outputFileTracingRoot: join(__dirname, '../..') } : {}),
  reactStrictMode: true,
  // Uploads go through server actions: employee documents up to 10 MB and CVs up to 5 MB, plus form overhead.
  // The API enforces the real per-file limits.
  experimental: { serverActions: { bodySizeLimit: '11mb' } },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // SAMEORIGIN (not DENY) so the portal can preview its own PDFs inline; other sites still cannot frame it.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' }, // geolocation: punch-in location checks,
        ],
      },
    ];
  },
};

export default config;
