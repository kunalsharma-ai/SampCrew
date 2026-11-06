import type { Metadata } from 'next';

export const metadata: Metadata = { robots: { index: true, follow: true } };

export default function CareersLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg">
      <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">{children}</main>
      <footer className="mx-auto max-w-3xl px-4 pb-10 text-xs text-fg-subtle">Hiring with SampCrew by SAMPLEDGE</footer>
    </div>
  );
}
