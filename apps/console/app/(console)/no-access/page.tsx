import { EmptyState, buttonClass } from '@crew/ui';
import { Lock } from 'lucide-react';
import Link from 'next/link';

export default function NoAccess() {
  return (
    <div className="py-16">
      <EmptyState icon={<Lock className="size-6" />} title="Your console role does not include this" description="Ask a super admin if you need it." action={<Link href="/tenants" className={buttonClass('secondary')}>Go to tenants</Link>} />
    </div>
  );
}
