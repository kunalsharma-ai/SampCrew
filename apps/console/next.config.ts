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
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
