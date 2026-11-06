import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
// Fonts are served from SampCrew itself (not Google Fonts), so no page view sends visitors' addresses to a third party.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'SampCrew Console', template: '%s · SampCrew Console' },
  description: 'SAMPLEDGE internal console for operating SampCrew.',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: '/apple-touch-icon.png',
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

// Light or dark, and the neon (default) or classic look, as each SAMPLEDGE admin last chose on this browser.
const themeScript = `try{var d=document.documentElement,t=localStorage.getItem('crew-theme'),s=localStorage.getItem('crew-console-style');if(t==='light'||t==='dark')d.dataset.theme=t;if(s==='classic')d.dataset.style='classic'}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The script nonce for this request (middleware.ts); the Content Security Policy runs no inline script without it.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" data-style="neon" data-backdrop="aurora" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <div className="crew-ambient" aria-hidden />
        {children}
      </body>
    </html>
  );
}
