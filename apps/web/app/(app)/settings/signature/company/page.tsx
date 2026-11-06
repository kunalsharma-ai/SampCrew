import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { CompanySignature, SignatureAgent } from '../types';
import { CompanySignatureView, type SignaturePerson } from './company-view';

export const metadata: Metadata = { title: 'Company email signature' };

export default async function CompanySignaturePage() {
  const [settings, overview] = await Promise.all([
    load<CompanySignature>('/signatures/settings'),
    load<{ people: SignaturePerson[]; agents: Array<SignatureAgent & { employeeId: string }> }>('/signatures/overview'),
  ]);
  return (
    <>
      <PageHeader
        eyebrow="Outlook"
        title="Company email signature"
        description="Company details, logo and colours that every signature uses, which design people start from, and how their computers keep Outlook up to date."
        actions={<Link href="/settings/signature" className="text-[0.8125rem] font-medium text-accent hover:underline">My own signature</Link>}
      />
      <CompanySignatureView settings={settings} people={overview.people} agents={overview.agents} />
    </>
  );
}
