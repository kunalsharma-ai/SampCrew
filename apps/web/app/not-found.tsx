import { CrewLogo, buttonClass } from '@crew/ui';
import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-6 text-center">
      <div className="grid justify-items-center gap-4">
        <CrewLogo />
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="max-w-sm text-sm text-fg-muted">The page you are looking for does not exist, or it was moved.</p>
        <Link href="/" className={buttonClass('primary')}>Go to CREW</Link>
      </div>
    </main>
  );
}
