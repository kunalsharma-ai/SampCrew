'use client';
import { MANDATORY_CATEGORIES, NOTIFICATION_CATEGORIES, type NotificationCategory, type NotificationPolicy } from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, Switch } from '@crew/ui';
import { useState, useTransition } from 'react';
import { saveNotificationPolicyAction } from '../../../notifications/actions';

export function PolicyEditor({ initial }: { initial: { policy: NotificationPolicy; updatedAt: string | null; members: number } }) {
  const [p, setP] = useState(initial.policy);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const toggleIn = (list: 'mandatory' | 'emailRequired', key: NotificationCategory, on: boolean) =>
    setP((cur) => ({ ...cur, [list]: on ? [...new Set([...cur[list], key])] : cur[list].filter((k) => k !== key) }));
  const save = () => start(async () => {
    const r = await saveNotificationPolicyAction(p);
    if (r.ok) {
      setP(r.data!.policy);
      setMsg({ tone: 'success', text: `Saved. It applies to all ${r.data!.members} people in your organisation now.` });
    } else setMsg({ tone: 'danger', text: r.message });
  });
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader title="Required for everyone" description="Always shown means people cannot hide that category in SampCrew. Always emailed means its emails cannot be switched off. Approvals and Workspace & security are always shown." />
        <CardBody className="overflow-x-auto p-0">
          <table className="w-full min-w-[28rem] text-[0.8125rem]">
            <thead className="text-xs text-fg-subtle"><tr className="border-b border-border"><th className="px-5 py-2 text-left font-medium">Category</th><th className="px-3 py-2 font-medium">Always shown</th><th className="px-3 py-2 font-medium">Always emailed</th></tr></thead>
            <tbody className="divide-y divide-border">
              {NOTIFICATION_CATEGORIES.map((c) => {
                const builtIn = MANDATORY_CATEGORIES.includes(c.key);
                return (
                  <tr key={c.key} data-testid={`policy-${c.key}`}>
                    <td className="px-5 py-2.5"><div className="font-medium">{c.label}</div><div className="text-xs text-fg-muted">{c.description}</div></td>
                    <td className="px-3 py-2.5 text-center"><span className="inline-flex"><Switch label={`${c.label} always shown`} checked={builtIn || p.mandatory.includes(c.key)} disabled={builtIn} onChange={(v) => toggleIn('mandatory', c.key, v)} testId={`policy-${c.key}-mandatory`} /></span></td>
                    <td className="px-3 py-2.5 text-center"><span className="inline-flex"><Switch label={`${c.label} always emailed`} checked={c.key === 'system' || p.emailRequired.includes(c.key)} disabled={c.key === 'system'} onChange={(v) => toggleIn('emailRequired', c.key, v)} testId={`policy-${c.key}-email`} /></span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardBody>
      </Card>
      <div className="grid content-start gap-4">
        <Card>
          <CardHeader title="Allowed in your organisation" description="Switching one off turns it off for everyone, whatever they chose." />
          <CardBody className="grid gap-3">
            <Row text="Notification sounds (web and phone)"><Switch label="Notification sounds allowed" checked={p.allowSound} onChange={(v) => setP((c) => ({ ...c, allowSound: v }))} testId="policy-allow-sound" /></Row>
            <Row text="Desktop (browser) notifications"><Switch label="Desktop notifications allowed" checked={p.allowDesktop} onChange={(v) => setP((c) => ({ ...c, allowDesktop: v }))} testId="policy-allow-desktop" /></Row>
            <Row text="Phone push notifications"><Switch label="Phone push allowed" checked={p.allowPush} onChange={(v) => setP((c) => ({ ...c, allowPush: v }))} testId="policy-allow-push" /></Row>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Starting choices" description="For people who have not changed their own settings yet. Anyone can change these for themselves." />
          <CardBody className="grid gap-3">
            <Row text="Sound on"><Switch label="Sound on by default" checked={p.defaults.sound} disabled={!p.allowSound} onChange={(v) => setP((c) => ({ ...c, defaults: { ...c.defaults, sound: v } }))} testId="policy-default-sound" /></Row>
            <Row text="Pop-ups in the corner"><Switch label="Pop-ups by default" checked={p.defaults.toasts} onChange={(v) => setP((c) => ({ ...c, defaults: { ...c.defaults, toasts: v } }))} /></Row>
            <Row text="Desktop notifications"><Switch label="Desktop notifications by default" checked={p.defaults.desktop} disabled={!p.allowDesktop} onChange={(v) => setP((c) => ({ ...c, defaults: { ...c.defaults, desktop: v } }))} /></Row>
          </CardBody>
        </Card>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Button loading={pending} onClick={save} data-testid="policy-save">Save notification policy</Button>
        <p className="text-xs text-fg-subtle">Every change is recorded in the audit trail. People who are signed in pick up the new rules straight away.</p>
      </div>
    </div>
  );
}

function Row({ text, children }: { text: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-3 text-[0.8125rem]"><span aria-hidden>{text}</span>{children}</div>;
}
