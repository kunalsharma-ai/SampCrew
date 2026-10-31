import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@crew/ui'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Uploads go through server actions: employee documents up to 10 MB and CVs up to 5 MB, plus form overhead.
  // The API enforces the real per-file limits.
  experimental: { serverActions: { bodySizeLimit: '11mb' } },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' }, // geolocation: punch-in location checks,
        ],
      },
    ];
  },
};

export default config;
