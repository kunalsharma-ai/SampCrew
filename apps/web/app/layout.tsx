import { appearanceAttributes, themeStylesheet } from '@crew/contracts';
import type { Metadata, Viewport } from 'next';
import { appearanceFromCookie } from '@/lib/appearance-cookie';
// Fonts are served from CREW itself (not Google Fonts), so no page view sends visitors' addresses to a third party.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'CREW', template: '%s · CREW' },
  description: 'CREW by SAMPLEDGE: one intelligent platform for your entire workforce.',
  icons: { icon: '/icon.svg' },
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
