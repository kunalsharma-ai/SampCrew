import { SubNav } from '@/components/sub-nav';

/** The single Email signature page: your own signature and, for admins, the company settings, as two tabs. */
export function SignatureTabs({ current }: { current: string }) {
  return <SubNav label="Email signature" current={current} items={[{ href: '/settings/signature', label: 'My signature' }, { href: '/settings/signature/company', label: 'Company signature' }]} />;
}
