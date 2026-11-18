'use client';
import { Card, CardBody, CardHeader } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { MfaVerifyForm } from '@/components/mfa-step-up';

/** Verify (or turn on) two-step verification right here, then go back to the page that asked for it. */
export function NoAccessMfa({ mfaEnabled, from }: { mfaEnabled: boolean; from: string | null }) {
  const router = useRouter();
  return (
    <Card className="mx-auto mt-6 max-w-md" data-testid="no-access-mfa">
      <CardHeader title={mfaEnabled ? 'Verify with your authenticator app' : 'Turn on two-step verification'} description={from ? 'You go straight back to the page you opened.' : undefined} />
      <CardBody>
        <MfaVerifyForm mfaEnabled={mfaEnabled} compact onVerified={() => { router.replace(from ?? '/'); router.refresh(); }} />
      </CardBody>
    </Card>
  );
}
