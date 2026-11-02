import { join } from 'node:path';
import type { NextConfig } from 'next';

// Container images build with NEXT_OUTPUT=standalone: a self-contained server with only the files it needs.
const standalone = process.env.NEXT_OUTPUT === 'standalone';

// Content Security Policy. Scripts and styles only from CREW itself; Next.js still needs inline scripts and styles
// (its streaming payload, the saved theme), so those are allowed, but no other site can supply code, fonts or frames.
// Development adds 'unsafe-eval', which Next.js needs for hot reload.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

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
          { key: 'Content-Security-Policy', value: csp },
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
