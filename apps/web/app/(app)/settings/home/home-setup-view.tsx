'use client';
import { HOME_COUNT_CARDS, HOME_SECTIONS, type HomeCountCard, type HomeSection } from '@crew/contracts';
import { Alert, Button, Card, CardHeader, Checkbox } from '@crew/ui';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { saveExperienceAction } from '../../experience-actions';

export function HomeSetupView({ hiddenCards, hiddenSections }: { hiddenCards: HomeCountCard[]; hiddenSections: HomeSection[] }) {
  const [cards, setCards] = useState<HomeCountCard[]>(hiddenCards);
  const [sections, setSections] = useState<HomeSection[]>(hiddenSections);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const flip = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const changed = JSON.stringify([...cards].sort()) !== JSON.stringify([...hiddenCards].sort()) || JSON.stringify([...sections].sort()) !== JSON.stringify([...hiddenSections].sort());
  const save = () => start(async () => {
    const r = await saveExperienceAction({ hiddenCards: cards, hiddenSections: sections }, true);
    setMsg(r.ok ? { ok: true, text: 'Home dashboard saved. Your Home now shows only what is ticked.' } : { ok: false, text: r.message ?? 'Could not save' });
  });
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-5" data-testid="home-setup">
      {msg && <Alert tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Alert>}
      <Card>
        <CardHeader title="Count cards" description="The figures at the top of Home. Each opens the attendance list behind it." />
        <div className="grid grid-cols-1 gap-2 px-5 pb-5 sm:grid-cols-2">
          {HOME_COUNT_CARDS.map((c) => (
            <Checkbox key={c.key} label={c.label} checked={!cards.includes(c.key)} onChange={() => setCards((x) => flip(x, c.key))} data-testid={`home-card-${c.key}`} />
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader title="Sections" description="The panels below the cards." />
        <div className="grid grid-cols-1 gap-2 px-5 pb-5 sm:grid-cols-2">
          {HOME_SECTIONS.map((c) => (
            <Checkbox key={c.key} label={c.label} checked={!sections.includes(c.key)} onChange={() => setSections((x) => flip(x, c.key))} data-testid={`home-section-${c.key}`} />
          ))}
        </div>
      </Card>
      <p className="text-[0.8125rem] text-fg-muted">Optional widgets (Workspace at a glance, Recently viewed, Personal notes and more) are added from <Link href="/" className="text-accent hover:underline">Home</Link> with Customize under More for you.</p>
      <div className="flex gap-2">
        <Button onClick={save} loading={pending} disabled={!changed} data-testid="home-setup-save">Save</Button>
        <Button variant="secondary" disabled={!changed || pending} onClick={() => { setCards(hiddenCards); setSections(hiddenSections); }}>Undo changes</Button>
      </div>
    </div>
  );
}
