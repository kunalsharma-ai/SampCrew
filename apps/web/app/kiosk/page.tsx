import type { Metadata } from 'next';
import { KioskScreen } from './kiosk-screen';

export const metadata: Metadata = { title: 'Attendance kiosk', robots: { index: false } };

export default function KioskPage() {
  return <KioskScreen />;
}
