'use client';
import { NOTIFICATION_CATEGORIES, notificationLocks, type NotificationPreferences, type NotificationPriority } from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, Select, Switch } from '@crew/ui';
import { Lock, Volume2 } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
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
  // Whether this browser lets SampCrew show system notifications ('unsupported' on browsers without them).
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  useEffect(() => setPermission(typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported'), []);
  const setDesktop = async (v: boolean) => {
    if (v && permission === 'default') {
      const r = await Notification.requestPermission().catch(() => 'denied' as const);
      setPermission(r);
      if (r !== 'granted') return;
    }
    setP((cur) => ({ ...cur, desktop: v }));
  };
  const locks = p.locks ?? notificationLocks();
  const setChannel = (key: string, channel: 'inApp' | 'email' | 'push' | 'sound', v: boolean) =>
    setP((cur) => ({ ...cur, categories: { ...cur.categories, [key]: { ...cur.categories[key as keyof typeof cur.categories], [channel]: v } } }));

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader title="What you are told about" description="In SampCrew means the bell, Home and the notices on each module's page. Phone means a push to the SampCrew app. A lock means your organisation decided it." />
        <CardBody className="overflow-x-auto p-0">
          <table className="w-full min-w-[34rem] text-[0.8125rem]">
            <thead className="text-xs text-fg-subtle">
              <tr className="border-b border-border">
                <th className="px-5 py-2 text-left font-medium">Category</th><th className="px-2 py-2 font-medium">In SampCrew</th><th className="px-2 py-2 font-medium">Email</th>
                <th className="px-2 py-2 font-medium">Phone</th><th className="px-2 py-2 font-medium">Sound</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {NOTIFICATION_CATEGORIES.map((c) => {
                const ch = p.categories[c.key];
                const cell = (channel: 'inApp' | 'email' | 'push' | 'sound', label: string, locked: boolean) => (
                  <td className="px-2 py-2.5 text-center">
                    <span className="inline-flex items-center gap-1">
                      <Switch label={`${c.label} ${label}`} checked={ch[channel] !== false} disabled={locked} onChange={(v) => setChannel(c.key, channel, v)} testId={`pref-${c.key}-${channel}`} />
                      {locked && <Lock className="size-3 text-fg-subtle" aria-label="Set by your organisation" />}
                    </span>
                  </td>
                );
                return (
                  <tr key={c.key} data-testid={`pref-${c.key}`}>
                    <td className="px-5 py-2.5"><div className="font-medium">{c.label}</div><div className="text-xs text-fg-muted">{c.description}</div></td>
                    {cell('inApp', 'in SampCrew', locks.inApp.includes(c.key))}
                    {cell('email', 'by email', locks.email.includes(c.key))}
                    {cell('push', 'on your phone', locks.push)}
                    {cell('sound', 'with sound', locks.sound)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardBody>
      </Card>
      <div className="grid content-start gap-4">
        <Card>
          <CardHeader title="Sound" description="A short, quiet tone when a notice arrives while SampCrew is open, once even with several tabs open. It never plays when a page loads; if the browser holds sound back, it plays at your next click." />
          <CardBody className="grid gap-4">
            {locks.sound && <p className="flex items-center gap-1.5 text-xs text-fg-muted" data-testid="sound-locked"><Lock className="size-3" aria-hidden />Your organisation keeps notifications silent. You still see every notice.</p>}
            <Row text="Play a sound for new notifications"><Switch label="Play a sound for new notifications" disabled={locks.sound} checked={p.sound.enabled} onChange={(v) => setP((cur) => ({ ...cur, sound: { ...cur.sound, enabled: v } }))} testId="sound-enabled" /></Row>
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
        <Card data-testid="desktop-notifications">
          <CardHeader title="Desktop notifications" description="A system notification on your computer when a notice arrives while SampCrew is in a background tab." />
          <CardBody className="grid gap-2">
            <Row text="Show desktop notifications"><Switch label="Show desktop notifications" checked={p.desktop} disabled={locks.desktop || permission === 'unsupported' || permission === 'denied'} onChange={(v) => void setDesktop(v)} testId="desktop-enabled" /></Row>
            {locks.desktop && <p className="flex items-center gap-1.5 text-xs text-fg-muted"><Lock className="size-3" aria-hidden />Your organisation does not use desktop notifications.</p>}
            {!locks.desktop && permission === 'default' && <Button size="sm" variant="secondary" onClick={() => void Notification.requestPermission().then(setPermission)} data-testid="desktop-permission">Allow notifications in this browser</Button>}
            {permission === 'granted' && !locks.desktop && <p className="text-xs text-success">This browser may show SampCrew notifications.</p>}
            {permission === 'denied' && <p className="text-xs text-fg-muted">Your browser blocks notifications from SampCrew. Allow them in the browser's site settings, then switch this on.</p>}
            {permission === 'unsupported' && <p className="text-xs text-fg-muted">This browser cannot show desktop notifications.</p>}
          </CardBody>
        </Card>
        <Card data-testid="quiet-hours">
          <CardHeader title="Quiet hours" description="No sound, pop-up or desktop notification in these hours. Notices still wait in the bell, and urgent ones still come through." />
          <CardBody className="grid gap-3">
            <Row text="Turn on quiet hours"><Switch label="Turn on quiet hours" checked={p.quiet.enabled} onChange={(v) => setP((cur) => ({ ...cur, quiet: { ...cur.quiet, enabled: v } }))} testId="quiet-enabled" /></Row>
            <div className="grid grid-cols-2 gap-3 text-[0.8125rem]">
              <label className="grid gap-1"><span>From</span><input type="time" className="h-9 rounded-md border border-border bg-surface px-2" value={p.quiet.from} disabled={!p.quiet.enabled} onChange={(e) => e.target.value && setP((cur) => ({ ...cur, quiet: { ...cur.quiet, from: e.target.value.slice(0, 5) } }))} data-testid="quiet-from" /></label>
              <label className="grid gap-1"><span>Until</span><input type="time" className="h-9 rounded-md border border-border bg-surface px-2" value={p.quiet.to} disabled={!p.quiet.enabled} onChange={(e) => e.target.value && setP((cur) => ({ ...cur, quiet: { ...cur.quiet, to: e.target.value.slice(0, 5) } }))} data-testid="quiet-to" /></label>
            </div>
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
