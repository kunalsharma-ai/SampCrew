import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { ScanPunch } from './scan-punch';

export const metadata: Metadata = { title: 'Punch with QR' };

/** Opened by scanning a kiosk QR code with a phone. The person is signed in, so the punch is theirs. */
export default async function ScanPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  return (
    <>
      <PageHeader title="Punch with QR" description="You scanned the code on a site kiosk. Confirm to record your punch." />
      <ScanPunch code={c ?? ''} />
    </>
  );
}
