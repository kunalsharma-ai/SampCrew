import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ApiError, api, load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { SignatureStudio } from './signature-studio';
import { SignatureTabs } from './tabs';
import type { MySignature } from './types';

export const metadata: Metadata = { title: 'Email signature' };

export default async function SignaturePage() {
  const me = await load<Me>('/me');
  let mine: MySignature | null = null;
  try {
    mine = await api<MySignature>('/signatures/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect('/login?expired=1');
    if (!(e instanceof ApiError && e.code === 'no_employee_record')) throw e;
  }
  const admin = can(me, 'org:manage');
  return (
    <>
      <PageHeader
        eyebrow="Outlook"
        title="Email signature"
        description={admin ? 'One place for email signatures: your own, and the company design, logo and details every signature uses.' : 'Pick one of 20 designs, make it yours and see it exactly as Outlook will show it. Then set up your Windows computer once and SampCrew keeps the signature in Outlook up to date.'}
      />
      {admin && <SignatureTabs current="/settings/signature" />}
      {mine ? (
        <SignatureStudio initial={mine} />
      ) : (
        <p className="text-[0.8125rem] text-fg-muted">Your login is not linked to an employee record in this workspace, so there is no signature to set up. {admin && 'You can still set the company design, logo and details under Company signature.'}</p>
      )}
    </>
  );
}

