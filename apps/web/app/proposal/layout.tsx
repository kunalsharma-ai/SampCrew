import type { Metadata } from 'next';

// A proposal link is private: keep it out of search engines and do not send it on to other sites.
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default function ProposalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg">
      <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">{children}</main>
      <footer className="mx-auto max-w-3xl px-4 pb-10 text-xs text-fg-subtle">Sent with CREW by SAMPLEDGE</footer>
    </div>
  );
}
