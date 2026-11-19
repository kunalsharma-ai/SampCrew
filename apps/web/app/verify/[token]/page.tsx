import type { Metadata } from 'next';
import { publicLoad } from '../../careers/public-api';
import type { PortalCase } from '../types';
import { Portal } from './portal';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: { absolute: 'Verification request' } };

export default async function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await publicLoad<PortalCase>(`/bgv-portal/${/^[A-Za-z0-9_-]{40,60}$/.test(token) ? token : 'invalid-link-invalid-link-invalid-link-xx'}`);
  return <Portal token={token} initial={data} />;
}
