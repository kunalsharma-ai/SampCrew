import { appearanceAttributes, themeStylesheet } from '@crew/contracts';
import type { Metadata, Viewport } from 'next';
import { appearanceFromCookie } from '@/lib/appearance-cookie';
// Fonts are served from SampCrew itself (not Google Fonts), so no page view sends visitors' addresses to a third party.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'SampCrew', template: '%s · SampCrew' },
  description: 'SampCrew by SAMPLEDGE. People, simplified: one intelligent platform for your entire workforce.',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: [{ media: '(prefers-color-scheme: dark)', color: '#070b1a' }, { color: '#f5f6fc' }] };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The member's saved theme is rendered on the server, so there is no flash of the default theme.
  const appearance = await appearanceFromCookie();
  return (
    <html lang="en" suppressHydrationWarning {...appearanceAttributes(appearance)}>
      <head>
        <style id="crew-theme" dangerouslySetInnerHTML={{ __html: themeStylesheet(appearance) }} />
      </head>
      <body>
        <div className="crew-ambient" aria-hidden />
        {children}
      </body>
    </html>
  );
}
