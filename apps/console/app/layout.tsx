import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
// Fonts are served from CREW itself (not Google Fonts), so no page view sends visitors' addresses to a third party.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'CREW Console', template: '%s · CREW Console' },
  description: 'SAMPLEDGE internal console for operating CREW.',
  icons: { icon: '/icon.svg' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

const themeScript = `try{var t=localStorage.getItem('crew-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The script nonce for this request (middleware.ts); the Content Security Policy runs no inline script without it.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
