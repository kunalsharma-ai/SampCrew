'use client';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Smartphone } from 'lucide-react';
import { useRunner } from '../../recruitment/use-runner';
import { signOutDeviceAction } from './device-actions';

export interface MobileDevice {
  id: string;
  platform: string;
  model: string;
  appVersion: string;
  osVersion: string;
  pushEnabled: boolean;
  registeredAt: string;
  lastSeenAt: string;
  lastSyncAt: string | null;
  revokedAt: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const PLATFORM: Record<string, string> = { ios: 'iPhone or iPad', android: 'Android', web: 'Browser preview' };

/** Phones signed in to the CREW app. Signing one out here ends its sign-in, stops its push and refuses its queued punches. */
export function MobileDevices({ devices }: { devices: MobileDevice[] }) {
  const { pending, notice, run } = useRunner();
  return (
    <Card>
      <CardHeader title="Mobile app" description="Phones signed in to the CREW app. Lost a phone? Sign it out here." />
      {notice && <div className="px-5 pb-3"><Alert tone={notice.tone}>{notice.text}</Alert></div>}
      {devices.length ? (
        <Table>
          <THead><tr><TH>Device</TH><TH>Last seen</TH><TH>Push</TH><TH /></tr></THead>
          <TBody>
            {devices.map((d) => (
              <TR key={d.id} className={d.revokedAt ? 'opacity-60' : undefined}>
                <TD>
                  <span className="font-medium">{d.model || PLATFORM[d.platform] || d.platform}</span>
                  <div className="text-xs text-fg-muted">{PLATFORM[d.platform] ?? d.platform}{d.osVersion ? ` ${d.osVersion}` : ''} · app {d.appVersion || '?'}</div>
                </TD>
                <TD className="text-fg-muted">{when(d.lastSeenAt)}{d.lastSyncAt ? <div className="text-xs">punches sent {when(d.lastSyncAt)}</div> : null}</TD>
                <TD>{d.pushEnabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}</TD>
                <TD className="text-right">
                  {d.revokedAt ? <Badge>Signed out</Badge> : <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Sign this phone out of CREW?') && run(() => signOutDeviceAction(d.id))}>Sign out</Button>}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <div className="p-5"><EmptyState icon={<Smartphone className="size-5" />} title="No phones yet" description="Sign in to the CREW app on your phone to punch attendance, apply for leave and ask HR on the go." /></div>
      )}
    </Card>
  );
}
