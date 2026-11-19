'use client';
import { MANDATORY_CATEGORIES, NOTIFICATION_CATEGORIES, type NotificationPreferences, type NotificationPriority } from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, Select, Switch } from '@crew/ui';
import { Volume2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { useOptionalLive } from '@/components/live';
import { playNotificationSound } from '@/lib/notification-sound';
import { saveNotificationPreferencesAction } from '../../notifications/actions';

const PRIORITIES: { key: NotificationPriority; label: string }[] = [
  { key: 'low', label: 'Every notice' },
  { key: 'normal', label: 'Normal and above' },
  { key: 'high', label: 'Important and urgent' },
  { key: 'urgent', label: 'Urgent only' },
];

export function NotificationSettings({ initial }: { initial: NotificationPreferences }) {
  const live = useOptionalLive();
  const [p, setP] = useState(initial);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    const r = await saveNotificationPreferencesAction(p);
    setMsg(r.ok ? { tone: 'success', text: 'Notification settings saved.' } : { tone: 'danger', text: r.message });
    if (r.ok) {
      setP(r.data!);
      live?.setPrefs(r.data!);
    }
  });
  const setChannel = (key: string, channel: 'inApp' | 'email', v: boolean) =>
    setP((cur) => ({ ...cur, categories: { ...cur.categories, [key]: { ...cur.categories[key as keyof typeof cur.categories], [channel]: v } } }));

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader title="What you are told about" description="In SampCrew means the bell, Home and the Notification Center. Approvals and workspace notices always show in SampCrew." />
        <CardBody className="p-0">
          <table className="w-full text-[0.8125rem]">
            <thead className="text-xs text-fg-subtle">
              <tr className="border-b border-border"><th className="px-5 py-2 text-left font-medium">Category</th><th className="px-3 py-2 font-medium">In SampCrew</th><th className="px-3 py-2 font-medium">Email</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {NOTIFICATION_CATEGORIES.map((c) => (
                <tr key={c.key} data-testid={`pref-${c.key}`}>
                  <td className="px-5 py-2.5"><div className="font-medium">{c.label}</div><div className="text-xs text-fg-muted">{c.description}</div></td>
                  <td className="px-3 py-2.5 text-center"><span className="inline-flex"><Switch label={`${c.label} in SampCrew`} checked={p.categories[c.key].inApp} disabled={MANDATORY_CATEGORIES.includes(c.key)} onChange={(v) => setChannel(c.key, 'inApp', v)} /></span></td>
                  <td className="px-3 py-2.5 text-center"><span className="inline-flex"><Switch label={`${c.label} by email`} checked={p.categories[c.key].email} disabled={c.key === 'system'} onChange={(v) => setChannel(c.key, 'email', v)} /></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>
      <div className="grid content-start gap-4">
        <Card>
          <CardHeader title="Sound" description="A short, quiet tone when a notice arrives while SampCrew is open. Off until you switch it on; it never plays when a page loads." />
          <CardBody className="grid gap-4">
            <Row text="Play a sound for new notifications"><Switch label="Play a sound for new notifications" checked={p.sound.enabled} onChange={(v) => setP((cur) => ({ ...cur, sound: { ...cur.sound, enabled: v } }))} testId="sound-enabled" /></Row>
            <label className="grid gap-1 text-[0.8125rem]">
              <span className="flex justify-between"><span>Volume</span><span className="text-fg-muted">{p.sound.volume}%</span></span>
              <input type="range" min={0} max={100} step={5} value={p.sound.volume} aria-label="Volume" disabled={!p.sound.enabled} onChange={(e) => setP((cur) => ({ ...cur, sound: { ...cur.sound, volume: Number(e.target.value) } }))} />
            </label>
            <label className="grid gap-1 text-[0.8125rem]">
              <span>Which notices make a sound</span>
              <Select aria-label="Which notices make a sound" value={p.sound.minPriority} disabled={!p.sound.enabled} onChange={(e) => setP((cur) => ({ ...cur, sound: { ...cur.sound, minPriority: e.target.value as NotificationPriority } }))}>
                {PRIORITIES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </Select>
            </label>
            <div className="grid gap-1.5">
              <span className="text-xs text-fg-muted">Preview each priority</span>
              <div className="flex flex-wrap gap-2">
                {(['normal', 'high', 'urgent'] as const).map((pr) => (
                  <Button key={pr} size="sm" variant="secondary" onClick={() => playNotificationSound(pr, p.sound.volume || 60, { fromGesture: true })}>
                    <Volume2 className="size-3.5" /> {pr === 'high' ? 'Important' : pr[0]!.toUpperCase() + pr.slice(1)}
                  </Button>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Pop-ups" />
          <CardBody>
            <Row text="Show a pop-up in the corner when a notice arrives"><Switch label="Show a pop-up in the corner when a notice arrives" checked={p.toasts} onChange={(v) => setP((cur) => ({ ...cur, toasts: v }))} /></Row>
          </CardBody>
        </Card>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Button loading={pending} onClick={save}>Save notification settings</Button>
      </div>
    </div>
  );
}

function Row({ text, children }: { text: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-3 text-[0.8125rem]"><span aria-hidden>{text}</span>{children}</div>;
}
