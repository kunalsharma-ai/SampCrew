'use client';
import { WELCOME_CARD, WELCOME_COPY, timeGreeting, type WelcomeScene as Scene } from '@crew/contracts';
import { useEffect, useState, type CSSProperties } from 'react';

/**
 * The welcome that plays right after signing in, before the dashboard shows: a full-screen scene in the level's own
 * colours (Super Admin Console, Super Workspace, HR Workspace, Employee Workspace), the person's name in big letters,
 * the workspace name in bold, rings, sparks and a "preparing your dashboard" line, then two curtains open onto the
 * dashboard, which has been loading underneath the whole time.
 *
 * It plays once per sign-in: the sign-in form calls markWelcomeIntro() just before it opens the app. A click, a tap,
 * Enter or Escape skips it. With reduced motion it is a short, still card that fades.
 */
const KEY = 'crew-welcome-intro';

export function markWelcomeIntro() {
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Private browsing without storage: no welcome, nothing else changes.
  }
}

function takeWelcomeIntro(): boolean {
  try {
    const at = Number(sessionStorage.getItem(KEY) ?? 0);
    sessionStorage.removeItem(KEY);
    // A flag older than a minute belongs to a sign-in that never reached the app.
    return at > 0 && Date.now() - at < 60_000;
  } catch {
    return false;
  }
}

const STEPS = ['Checking your access', 'Loading your workspace', 'Preparing your dashboard'];

export function WelcomeIntro({ scene, name, workspace, logoSrc }: { scene: Scene; name: string; workspace?: string | null; logoSrc?: string }) {
  const [phase, setPhase] = useState<'off' | 'in' | 'out'>('off');
  const [step, setStep] = useState(0);
  const [greeting, setGreeting] = useState('Welcome');

  useEffect(() => {
    if (!takeWelcomeIntro()) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setGreeting(timeGreeting(new Date().getHours()));
    setPhase('in');
    const timers = [
      window.setTimeout(() => setStep(1), still ? 300 : 900),
      window.setTimeout(() => setStep(2), still ? 600 : 1700),
      window.setTimeout(() => setPhase('out'), still ? 1100 : 3000),
      window.setTimeout(() => setPhase('off'), still ? 1500 : 3900),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  useEffect(() => {
    if (phase !== 'in') return;
    const skip = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') setPhase('out'); };
    document.addEventListener('keydown', skip);
    return () => document.removeEventListener('keydown', skip);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'out') return;
    const t = window.setTimeout(() => setPhase('off'), 900);
    return () => window.clearTimeout(t);
  }, [phase]);

  if (phase === 'off') return null;
  const copy = WELCOME_COPY[scene];
  const first = name.trim().split(/\s+/)[0] || name;
  const dark = scene !== 'employee' && scene !== 'team';
  return (
    <div
      className="wi"
      data-scene={scene}
      data-phase={phase}
      role="dialog"
      aria-modal="true"
      aria-label={`Welcome to your ${copy.level}`}
      data-testid="welcome-intro"
      onClick={() => setPhase('out')}
    >
      <div className="wi-curtain wi-curtain-l" aria-hidden />
      <div className="wi-curtain wi-curtain-r" aria-hidden />
      <div className="wi-stage" aria-hidden>
        <span className="wi-aurora" />
        <span className="wi-grid" />
        {[0, 1, 2].map((i) => <span key={i} className="wi-ring" style={{ '--i': i } as CSSProperties} />)}
        <span className="wi-orbit">{Array.from({ length: 10 }, (_, i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</span>
        <span className="wi-rain">{Array.from({ length: 22 }, (_, i) => <i key={i} style={{ '--i': i, '--x': `${(i * 37) % 100}%`, '--d': `${(i % 7) * 0.18}s` } as CSSProperties} />)}</span>
      </div>
      <div className="wi-content">
        <img src={logoSrc ?? `/brand/sampcrew-logo-${dark ? 'dark' : 'light'}.svg`} alt="SampCrew" className="wi-logo" width={196} height={52} />
        <p className="wi-hello">{greeting}</p>
        <h2 className="wi-name" data-testid="welcome-intro-name">
          {Array.from(first).map((ch, i, all) => <span key={i} className="wi-ch" style={{ '--i': i, '--n': Math.max(all.length, 2) } as CSSProperties}>{ch}</span>)}
        </h2>
        <p className="wi-to">
          Welcome to your <strong data-testid="welcome-intro-level">{copy.level}</strong>
          {workspace && <> at <strong>{workspace}</strong></>}
        </p>
        <p className="wi-kicker">{WELCOME_CARD[scene].kicker} · {copy.title}</p>
        <div className="wi-progress" role="status" aria-live="polite">
          <span className="wi-bar"><span /></span>
          <span className="wi-step" key={step}>{STEPS[step]}…</span>
        </div>
        <button type="button" className="wi-skip" onClick={(e) => { e.stopPropagation(); setPhase('out'); }}>Skip</button>
      </div>
    </div>
  );
}
