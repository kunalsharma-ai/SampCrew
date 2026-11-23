'use client';
import { SIGN_IN_PALETTES, WELCOME_CARD, WELCOME_COPY, WELCOME_HELLOS, sceneIsDark, timeGreeting, type SignInMode, type WelcomeScene as Scene } from '@crew/contracts';
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '../cn';
import { SignInStatusProvider, useSignInStatus } from './sign-in-feedback';

/**
 * The SampCrew sign-in experience, shared by the Web Portal and the Console. Each level is its own animated world,
 * in the colours of the product the person is about to enter, and greets them: the time of day, "hello" in turn in
 * the languages SampCrew's customers speak, and the workspace's name in bold, so nobody signs in to the wrong place.
 *
 * - console   Super Admin Console (SAMPLEDGE staff only): a night-blue command centre, a turning wireframe globe with
 *             satellites and a radar sweep, live status panels and a scan line.
 * - super     Super Workspace: emerald and gold, a crowned core with HR Workspaces orbiting it, data flowing along gold
 *             links and a twinkling starfield.
 * - hr        HR Workspace: violet and coral, a hiring board where a candidate card travels Applied, Interview, Hired
 *             and lands in a burst of confetti, over slowly morphing colour blobs.
 * - employee  Employee Workspace: a warm daylight scene, a rising sun and drifting clouds, a check-in that ticks, leave
 *             days filling the calendar and a payslip ready to download.
 * - team      Employee Workspace of someone people report to: the same daylight, with their team gathering and
 *             requests being approved.
 *
 * The form sits in a sign-in card of the same world (a moving gradient frame, the workspace's badge, field icons and
 * what keeps the account safe). People can switch the page to light or dark and try other colour palettes; the
 * choice stays on this device. The official logo is shown unchanged. Only transform and opacity move, so it stays
 * smooth on slow machines; with reduced motion it is a still composition. Decoration is hidden from screen readers and
 * the words are real text. The form is usable from the first frame: nothing waits for the animation.
 */

type Choice = { label: string; href: string; active: boolean; scene?: Scene };
const PREFS_KEY = 'crew-signin-theme';
const PALETTE_KEYS = new Set(SIGN_IN_PALETTES.map((p) => p.key));

/** The page's look: light or dark (auto keeps each workspace's own) and the colour palette, remembered per device. */
function useSignInTheme() {
  const [mode, setMode] = useState<SignInMode>('auto');
  const [palette, setPalette] = useState('signature');
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as { mode?: string; palette?: string };
      if (raw.mode === 'light' || raw.mode === 'dark') setMode(raw.mode);
      if (raw.palette && PALETTE_KEYS.has(raw.palette)) setPalette(raw.palette);
    } catch {
      // Nothing saved, or no storage: the workspace's own look.
    }
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ mode, palette }));
    } catch {
      // No storage (private mode): the choice lasts for this page.
    }
  }, [mode, palette]);
  return { mode, setMode, palette, setPalette };
}

/** CSS variables for a palette on a dark or light page (signature keeps the workspace's own, from the stylesheet). */
function paletteStyle(key: string, tone: 'dark' | 'light'): CSSProperties | undefined {
  const p = SIGN_IN_PALETTES.find((x) => x.key === key);
  if (!p) return undefined;
  const t = p[tone];
  return {
    '--base': t.base,
    '--g1': p.colors[0], '--g2': p.colors[1], '--g3': p.colors[2],
    '--name': `linear-gradient(90deg, ${t.name[0]} 0%, ${t.name[1]} 40%, ${t.name[2]} 80%, ${t.name[0]} 100%)`,
  } as CSSProperties;
}
function paletteShellStyle(key: string): CSSProperties | undefined {
  const p = SIGN_IN_PALETTES.find((x) => x.key === key);
  if (!p) return undefined;
  return {
    '--sc-tint': p.tint, '--sc-c1': p.colors[0], '--sc-c2': p.colors[1], '--sc-c3': p.colors[2],
    '--sc-btn': `linear-gradient(100deg, ${p.colors[0]}, ${p.tint} 55%, ${p.colors[2]})`,
  } as CSSProperties;
}

/**
 * The whole sign-in page: the level's welcome, and beside it (below it on phones) the sign-in card with the theme
 * controls. The Web Portal and the Console both use it, with their own form inside.
 */
export function SignInFrame({
  scene,
  choices,
  heading = 'h1',
  footer,
  helpHref,
  children,
}: {
  scene: Scene;
  choices?: Choice[];
  /** The public Help & Support page, offered as a button above the card. */
  helpHref?: string;
  heading?: 'h1' | 'h2';
  /** A line under the card (copyright, audit note). */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { mode, setMode, palette, setPalette } = useSignInTheme();
  const tone: 'dark' | 'light' = mode === 'auto' ? (sceneIsDark(scene) ? 'dark' : 'light') : mode;
  return (
    <div className="sc-shell grid min-h-dvh bg-bg lg:grid-cols-[1fr_540px]" data-scene={scene} data-mode={mode} data-tone={tone} data-palette={palette} style={paletteShellStyle(palette)} data-testid="sign-in-page">
      <WelcomeScene scene={scene} choices={choices} heading={heading} tone={tone} style={paletteStyle(palette, tone)} className="min-h-0 lg:min-h-dvh" />
      <main className="sc-panel">
        <span className="sc-panel-blob sc-panel-blob-1" aria-hidden />
        <span className="sc-panel-blob sc-panel-blob-2" aria-hidden />
        <div className="sc-panel-inner">
          <ThemePicker
            mode={mode} onMode={setMode} palette={palette} onPalette={setPalette}
            lead={helpHref ? <a className="sc-help" href={helpHref} data-testid="sign-in-help"><HelpIcon />Help &amp; Support</a> : null}
          />
          <SignInCard scene={scene}>{children}</SignInCard>
          {footer && <div className="sc-panel-foot">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

/** The time-of-day greeting by the person's own clock (a plain welcome until the page knows it). */
function useGreeting() {
  const [g, setG] = useState('Welcome');
  useEffect(() => setG(timeGreeting(new Date().getHours())), []);
  return g;
}

export function WelcomeScene({
  scene,
  logoSrc,
  choices,
  className,
  heading: Heading = 'h1',
  tone,
  style,
}: {
  scene: Scene;
  /** The workspace name's element: h1 when the form beside it uses h2 (Web Portal), h2 when the form has the h1. */
  heading?: 'h1' | 'h2';
  /** Defaults to the official logo for a dark or light backdrop. */
  logoSrc?: string;
  /** Links to the other levels' sign-in. */
  choices?: Choice[];
  className?: string;
  /** Dark or light page; defaults to the workspace's own. */
  tone?: 'dark' | 'light';
  style?: CSSProperties;
}) {
  const copy = WELCOME_COPY[scene];
  const t = tone ?? (sceneIsDark(scene) ? 'dark' : 'light');
  const greeting = useGreeting();
  // The full reveal plays once per browser session; coming back to the page (after signing out) is quicker.
  const [quick, setQuick] = useState(false);
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem('crew-welcome-played')) setQuick(true);
      else window.sessionStorage.setItem('crew-welcome-played', '1');
    } catch {
      // No storage (private mode): the full reveal plays.
    }
  }, []);
  const words = copy.level.split(' ');
  const staff = WELCOME_CARD[scene].staffOnly;
  return (
    <section className={cn('sc-scene', quick && 'sc-quick', className)} data-scene={scene} data-tone={t} style={style} data-testid="welcome-scene" aria-label={`${copy.level} welcome`}>
      <Backdrop scene={scene} />
      <div className="sc-content">
        <div className="sc-top">
          <img src={logoSrc ?? `/brand/sampcrew-logo-${t === 'light' ? 'light' : 'dark'}.svg`} alt="SampCrew" className="sc-logo" width={243} height={64} />
          {staff && <span className="sc-staff" data-testid="staff-only"><LockIcon />SAMPLEDGE staff only</span>}
        </div>
        <div className="sc-copy" data-testid="welcome-copy">
          <p className="sc-greet" data-testid="welcome-greeting">
            <span className="sc-wave" aria-hidden>👋</span>
            <span className="sc-greet-text">{[...`${greeting}${staff ? ', SAMPLEDGE team' : ''}`].map((ch, i) => <span key={i} className="sc-ch" style={{ '--i': i } as CSSProperties}>{ch}</span>)}</span>
            <span className="sc-hello" aria-hidden><span className="sc-hello-track">{[...WELCOME_HELLOS, WELCOME_HELLOS[0]].map((h, i) => <span key={i}>{h}</span>)}</span></span>
          </p>
          <p className="sc-eyebrow"><span className="sc-eyebrow-dot" aria-hidden />{staff ? 'Welcome to the' : 'Welcome to your'}</p>
          <Heading className="sc-name" data-testid="welcome-level">
            {words.map((w, i) => (
              <Fragment key={w + i}>
                <span className="sc-word-mask"><strong className="sc-word" style={{ '--i': i } as CSSProperties}>{w}</strong></span>
                {i < words.length - 1 ? ' ' : null}
              </Fragment>
            ))}
          </Heading>
          <span className="sc-underline" aria-hidden />
          <p className="sc-title" data-testid="welcome-title">{copy.title}</p>
          <p className="sc-message">{copy.message}</p>
          <ul className="sc-highlights" aria-label="In this workspace">
            {copy.highlights.map((h, i) => <li key={h} style={{ '--i': i } as CSSProperties}>{h}</li>)}
          </ul>
          {choices && choices.length > 1 && (
            <nav className="sc-choices" aria-label="Choose where you are signing in">
              <span>Not this one?</span>
              {choices.map((c) => (
                <a key={c.href} href={c.href} data-to={c.scene} aria-current={c.active ? 'page' : undefined} className={cn(c.active && 'sc-choice-active')} data-testid="welcome-choice">
                  <span className="sc-choice-dot" aria-hidden />{c.label}
                </a>
              ))}
            </nav>
          )}
        </div>
        <div className="sc-stage" aria-hidden data-testid="welcome-stage">
          <svg viewBox="0 0 800 420" preserveAspectRatio="xMidYMid meet" focusable="false">
            {scene === 'console' && <ConsoleStage />}
            {scene === 'super' && <SuperStage />}
            {scene === 'hr' && <HrStage />}
            {scene === 'employee' && <EmployeeStage />}
            {scene === 'team' && <TeamStage />}
          </svg>
        </div>
        <p className="sc-foot">SampCrew · People, simplified. · by SAMPLEDGE</p>
      </div>
    </section>
  );
}

/** The sign-in card: a moving gradient frame, the workspace's badge and name, the form, and what keeps it safe. */
function SignInCard(props: { scene: Scene; children: ReactNode }) {
  return <SignInStatusProvider><SignInCardBody {...props} /></SignInStatusProvider>;
}

/** The burst over the card when the sign-in worked: a big tick drawing itself, a ring and sparks. */
function SuccessBurst({ name }: { name: string }) {
  return (
    <div className="sc-success" role="status" data-testid="sign-in-success">
      <span className="sc-success-glow" aria-hidden />
      <span className="sc-success-sparks" aria-hidden>{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</span>
      <svg className="sc-success-tick" viewBox="0 0 64 64" aria-hidden="true">
        <circle className="sc-success-ring" cx="32" cy="32" r="28" />
        <path className="sc-success-path" d="M19 33.5l8.5 8.5L45 24.5" />
      </svg>
      <p className="sc-success-title">Signed in</p>
      <p className="sc-success-sub">Opening your <strong>{name}</strong>…</p>
    </div>
  );
}

function SignInCardBody({ scene, children }: { scene: Scene; children: ReactNode }) {
  const copy = WELCOME_COPY[scene];
  const card = WELCOME_CARD[scene];
  const { status, attempt } = useSignInStatus();
  return (
    <div className="sc-card" data-testid="sign-in-card" data-auth={status} data-attempt={attempt % 2}>
      {status === 'ok' && <SuccessBurst name={copy.level} />}
      <span className="sc-card-frame" aria-hidden />
      <span className="sc-card-glow sc-card-glow-1" aria-hidden />
      <span className="sc-card-glow sc-card-glow-2" aria-hidden />
      <div className="sc-card-head">
        <span className="sc-card-badge" aria-hidden><SceneIcon scene={scene} /><span className="sc-card-badge-ring" /></span>
        <div className="sc-card-id">
          <p className="sc-card-kicker">{card.kicker}</p>
          <p className="sc-card-name" data-testid="card-workspace"><strong>{copy.level}</strong></p>
        </div>
        <span className={cn('sc-card-chip', card.staffOnly && 'sc-card-chip-staff')}><LockIcon />{card.staffOnly ? 'Staff only' : 'Secure'}</span>
      </div>
      <div className="sc-card-body">{children}</div>
      <ul className="sc-card-trust" aria-label="How your account is protected">
        <li><ShieldIcon />Multi-factor</li>
        <li><LockIcon />Encrypted</li>
        <li><EyeIcon />Every sign-in audited</li>
      </ul>
    </div>
  );
}

/** Light, dark or the workspace's own look, and colour palettes to try. */
function ThemePicker({ mode, onMode, palette, onPalette, lead }: { mode: SignInMode; onMode: (m: SignInMode) => void; palette: string; onPalette: (p: string) => void; lead?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const modes: { m: SignInMode; label: string; icon: ReactNode }[] = [
    { m: 'auto', label: 'Workspace look', icon: <SparkIcon /> },
    { m: 'light', label: 'Light', icon: <SunIcon /> },
    { m: 'dark', label: 'Dark', icon: <MoonIcon /> },
  ];
  const palettes = [{ key: 'signature', label: 'Signature', colors: ['var(--sc-c1)', 'var(--sc-c2)', 'var(--sc-c3)'] }, ...SIGN_IN_PALETTES];
  return (
    <div className="sc-theme" ref={box}>
      {lead}
      <div className="sc-theme-modes" role="group" aria-label="Page look">
        {modes.map((x) => (
          <button key={x.m} type="button" aria-pressed={mode === x.m} title={x.label} aria-label={x.label} onClick={() => onMode(x.m)} data-testid={`theme-mode-${x.m}`}>{x.icon}</button>
        ))}
      </div>
      <button type="button" className="sc-theme-open" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)} data-testid="theme-palettes">
        <span className="sc-theme-dots" aria-hidden><i /><i /><i /></span>Colours
      </button>
      {open && (
        <div className="sc-theme-pop" role="group" aria-label="Colour palette" data-testid="theme-palette-list">
          {palettes.map((p) => (
            <button key={p.key} type="button" aria-pressed={palette === p.key} onClick={() => onPalette(p.key)} data-testid={`theme-palette-${p.key}`}>
              <span className="sc-swatch" style={{ background: `conic-gradient(${p.colors[0]}, ${p.colors[1]}, ${p.colors[2]}, ${p.colors[0]})` }} aria-hidden />
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The world behind the words: light, glow and texture for each level. */
function Backdrop({ scene }: { scene: Scene }) {
  return (
    <div className="sc-bg" aria-hidden>
      <span className="sc-glow sc-glow-1" />
      <span className="sc-glow sc-glow-2" />
      <span className="sc-glow sc-glow-3" />
      <span className="sc-texture" />
      {scene === 'console' && <span className="sc-scanline" />}
      {scene === 'super' && <span className="sc-beams" />}
    </div>
  );
}

/* Small line icons (24px grid, currentColor). */
const I = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="sc-i">{children}</svg>;
const LockIcon = () => <I><rect x="4" y="11" width="16" height="10" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></I>;
const ShieldIcon = () => <I><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></I>;
const EyeIcon = () => <I><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></I>;
const SunIcon = () => <I><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></I>;
const MoonIcon = () => <I><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></I>;
const HelpIcon = () => <I><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" /><path d="M5.6 5.6l4 4M14.4 14.4l4 4M18.4 5.6l-4 4M9.6 14.4l-4 4" /></I>;
const SparkIcon = () => <I><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></I>;
function SceneIcon({ scene }: { scene: Scene }) {
  if (scene === 'console') return <I><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></I>;
  if (scene === 'super') return <I><path d="M3 18l2-11 5 5 2-7 2 7 5-5 2 11z" /><path d="M5 21h14" /></I>;
  if (scene === 'hr') return <I><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17.5" cy="9" r="2.5" /><path d="M16 14.2a5 5 0 0 1 6 4.8" /></I>;
  if (scene === 'team') return <I><circle cx="12" cy="7" r="3" /><circle cx="5" cy="10" r="2.3" /><circle cx="19" cy="10" r="2.3" /><path d="M6.5 20a5.5 5.5 0 0 1 11 0M1.5 19a4 4 0 0 1 5-3.6M22.5 19a4 4 0 0 0-5-3.6" /></I>;
  return <I><circle cx="12" cy="12" r="4" /><path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" /></I>;
}

const v = (o: Record<string, string | number>) => o as CSSProperties;

/* Super Admin Console ------------------------------------------------------------------------------------------- */
function ConsoleStage() {
  const panels: [string, string][] = [['All workspaces', 'Live'], ['Plans & billing', 'Synced'], ['Security & audit', 'Guarded']];
  return (
    <g>
      <defs>
        <radialGradient id="scc-globe" cx="40%" cy="35%" r="70%"><stop offset="0" stopColor="#1d4ed8" stopOpacity=".55" /><stop offset="1" stopColor="#020617" stopOpacity=".1" /></radialGradient>
        <linearGradient id="scc-sweep" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#22d3ee" stopOpacity="0" /><stop offset="1" stopColor="#22d3ee" stopOpacity=".55" /></linearGradient>
        <clipPath id="scc-clip"><circle cx="560" cy="210" r="148" /></clipPath>
      </defs>
      {/* Status panels */}
      {panels.map(([label, state], i) => (
        <g key={label} className="scc-panel" style={v({ '--d': `${0.5 + i * 0.25}s` })}><g transform={`translate(24 ${70 + i * 98})`}>
          <rect width="268" height="78" rx="10" fill="#0b1730" fillOpacity=".85" stroke="#22d3ee" strokeOpacity=".35" />
          <rect width="4" height="78" rx="2" fill="#22d3ee" />
          <text x="22" y="32" fill="#e2f6ff" fontSize="17" fontWeight="600" fontFamily="var(--font-mono, monospace)">{label}</text>
          <circle className="scc-ping" cx="28" cy="54" r="5" fill="#34d399" />
          <text x="42" y="59" fill="#34d399" fontSize="13" fontFamily="var(--font-mono, monospace)">{state}</text>
          {[0, 1, 2, 3, 4, 5, 6].map((b) => (
            <rect key={b} className="scc-spark" style={v({ '--d': `${(b * 0.17 + i * 0.3).toFixed(2)}s` })} x={150 + b * 14} y="36" width="8" height="30" rx="2" fill="#38bdf8" opacity=".75" />
          ))}
        </g></g>
      ))}
      {/* Globe */}
      <circle cx="560" cy="210" r="148" fill="url(#scc-globe)" stroke="#38bdf8" strokeOpacity=".7" strokeWidth="1.5" />
      {[-100, -50, 0, 50, 100].map((dy) => {
        const rx = Math.sqrt(148 * 148 - dy * dy);
        return <ellipse key={dy} cx="560" cy={210 + dy} rx={rx} ry={rx * 0.16} fill="none" stroke="#22d3ee" strokeOpacity=".28" />;
      })}
      {[0, 1, 2, 3, 4, 5].map((m) => (
        <ellipse key={m} className="scc-meridian" style={v({ '--d': `${-m * 1.5}s` })} cx="560" cy="210" rx="148" ry="148" fill="none" stroke="#22d3ee" strokeOpacity=".45" />
      ))}
      <g clipPath="url(#scc-clip)">
        <path className="scc-radar" d="M560 210 L720 150 A170 170 0 0 1 730 230 Z" fill="url(#scc-sweep)" />
      </g>
      {[[500, 150], [612, 182], [585, 280], [520, 250], [640, 120]].map(([x, y], i) => (
        <g key={i}>
          <circle className="scc-city" style={v({ '--d': `${i * 0.7}s` })} cx={x} cy={y} r="10" fill="none" stroke="#67e8f9" />
          <circle cx={x} cy={y} r="3.5" fill="#e0f2fe" />
        </g>
      ))}
      {/* Orbits with satellites */}
      {[{ r: 205, tilt: -16, dur: '11s', c: '#60a5fa' }, { r: 182, tilt: 24, dur: '15s', c: '#a78bfa' }].map((o, i) => (
        <g key={i} transform={`translate(560 210) rotate(${o.tilt}) scale(1 .3)`}>
          <circle r={o.r} fill="none" stroke={o.c} strokeOpacity=".45" strokeDasharray="3 7" />
          <g className="scc-orbit" style={v({ '--dur': o.dur })}>
            <circle cx={o.r} cy="0" r="9" fill={o.c} />
            <circle cx={o.r} cy="0" r="18" fill={o.c} opacity=".25" />
          </g>
        </g>
      ))}
    </g>
  );
}

/* Super Workspace ------------------------------------------------------------------------------------------------ */
function SuperStage() {
  const stars: [number, number, number][] = [[40, 40, 1.6], [120, 360, 1.2], [180, 90, 2], [260, 30, 1.2], [330, 380, 1.6], [470, 20, 1.4], [540, 400, 1.8], [620, 60, 1.2], [700, 330, 2], [760, 120, 1.4], [90, 220, 1.2], [720, 220, 1.2], [420, 395, 1.2], [300, 150, 1], [500, 120, 1], [650, 390, 1.2]];
  const tags: { x: number; y: number; label: string }[] = [{ x: 40, y: 70, label: 'HR Workspaces' }, { x: 590, y: 60, label: 'Modules & plans' }, { x: 40, y: 320, label: 'Policies' }, { x: 590, y: 330, label: 'Company insight' }];
  return (
    <g>
      <defs>
        <radialGradient id="scs-core" cx="40%" cy="35%" r="70%"><stop offset="0" stopColor="#fde68a" /><stop offset=".55" stopColor="#e3b341" /><stop offset="1" stopColor="#a16207" /></radialGradient>
        <linearGradient id="scs-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fde68a" /><stop offset="1" stopColor="#e3b341" /></linearGradient>
      </defs>
      {stars.map(([x, y, r], i) => <circle key={i} className="scs-star" style={v({ '--d': `${(i * 0.37) % 3}s` })} cx={x} cy={y} r={r} fill="#fef3c7" />)}
      {/* Gold links from the core to what the Super Workspace runs, with light flowing along them */}
      {tags.map((t, i) => {
        const tx = t.x + (t.x < 400 ? 170 : 0);
        const ty = t.y + 20;
        return (
          <g key={t.label}>
            <path d={`M400 210 Q ${(400 + tx) / 2} ${ty < 210 ? 210 : 210} ${tx} ${ty}`} fill="none" stroke="#e3b341" strokeOpacity=".35" strokeWidth="1.5" />
            <path className="scs-flow" style={v({ '--d': `${i * 0.6}s` })} d={`M400 210 Q ${(400 + tx) / 2} 210 ${tx} ${ty}`} fill="none" stroke="#fde68a" strokeWidth="2.5" strokeLinecap="round" pathLength={100} />
            <g className="scs-tag" style={v({ '--d': `${0.6 + i * 0.2}s` })}><g transform={`translate(${t.x} ${t.y})`}>
              <rect width="170" height="40" rx="20" fill="#0c2a22" fillOpacity=".9" stroke="#e3b341" strokeOpacity=".6" />
              <circle cx="20" cy="20" r="5" fill="#34d399" />
              <text x="34" y="25.5" fill="#fef3c7" fontSize="14.5" fontWeight="600">{t.label}</text>
            </g></g>
          </g>
        );
      })}
      {/* Orbits (HR Workspaces circling the organisation) */}
      {[{ r: 150, tilt: -14, dur: '14s', c: '#34d399' }, { r: 118, tilt: 18, dur: '10s', c: '#fde68a' }, { r: 184, tilt: 4, dur: '20s', c: '#a7f3d0' }].map((o, i) => (
        <g key={i} transform={`translate(400 210) rotate(${o.tilt}) scale(1 .32)`}>
          <circle r={o.r} fill="none" stroke="#e3b341" strokeOpacity=".4" />
          <g className="scs-orbit" style={v({ '--dur': o.dur, '--d': `${-i * 3}s` })}>
            <circle cx={o.r} cy="0" r="12" fill={o.c} />
            <circle cx={-o.r} cy="0" r="7" fill="#fef3c7" opacity=".8" />
          </g>
        </g>
      ))}
      {/* The crowned core */}
      {[0, 1, 2].map((i) => <circle key={i} className="scs-ripple" style={v({ '--d': `${i * 1.2}s` })} cx="400" cy="210" r="46" fill="none" stroke="#e3b341" strokeWidth="2" />)}
      <circle cx="400" cy="210" r="46" fill="url(#scs-core)" />
      <circle cx="400" cy="210" r="46" fill="none" stroke="#fff7d6" strokeOpacity=".7" strokeWidth="1.5" />
      <path d="M378 222 l-4 -24 l14 11 l12 -18 l12 18 l14 -11 l-4 24 z" fill="#0c2620" />
      <rect x="378" y="225" width="44" height="6" rx="3" fill="#0c2620" />
    </g>
  );
}

/* HR Workspace --------------------------------------------------------------------------------------------------- */
function HrStage() {
  const cols = ['Applied', 'Interview', 'Hired'];
  const card = (x: number, y: number, a: string, key?: string) => (
    <g key={key} transform={`translate(${x} ${y})`}>
      <rect width="196" height="64" rx="16" fill="#ffffff" fillOpacity=".96" />
      <circle cx="32" cy="32" r="17" fill={a} />
      <rect x="60" y="20" width="96" height="9" rx="4.5" fill="#2e1065" opacity=".75" />
      <rect x="60" y="36" width="64" height="8" rx="4" fill="#7c3aed" opacity=".3" />
    </g>
  );
  return (
    <g>
      <defs>
        <linearGradient id="sch-a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fb8a7e" /><stop offset="1" stopColor="#f472b6" /></linearGradient>
        <linearGradient id="sch-b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a78bfa" /><stop offset="1" stopColor="#7c3aed" /></linearGradient>
        <linearGradient id="sch-c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fbbf24" /><stop offset="1" stopColor="#fb8a7e" /></linearGradient>
      </defs>
      {cols.map((c, i) => (
        <g key={c} className="sch-col" style={v({ '--d': `${0.3 + i * 0.15}s` })}><g transform={`translate(${30 + i * 252} 30)`}>
          <rect width="236" height="360" rx="24" fill="#ffffff" fillOpacity=".12" stroke="#ffffff" strokeOpacity=".28" />
          <text x="20" y="38" fill="#fff" fontSize="18" fontWeight="700">{c}</text>
          <rect x="176" y="20" width="40" height="26" rx="13" fill={i === 2 ? '#34d399' : '#ffffff'} fillOpacity={i === 2 ? 1 : 0.22} />
          <text x="196" y="38" textAnchor="middle" fill={i === 2 ? '#064e3b' : '#fff'} fontSize="13" fontWeight="700">{[12, 5, 3][i]}</text>
        </g></g>
      ))}
      {card(50, 152, 'url(#sch-b)', 'a1')}
      {card(50, 230, 'url(#sch-c)', 'a2')}
      {card(302, 152, 'url(#sch-a)', 'b1')}
      {card(554, 152, 'url(#sch-b)', 'c1')}
      {/* The card that travels to Hired */}
      <g className="sch-mover">
        <g transform="translate(50 80)">
          <rect width="196" height="64" rx="16" fill="#ffffff" />
          <rect width="196" height="64" rx="16" fill="none" stroke="#fb8a7e" strokeWidth="2.5" />
          <circle cx="32" cy="32" r="17" fill="url(#sch-a)" />
          <rect x="60" y="20" width="96" height="9" rx="4.5" fill="#2e1065" opacity=".85" />
          <rect x="60" y="36" width="64" height="8" rx="4" fill="#fb8a7e" opacity=".6" />
          <g className="sch-check">
            <circle cx="178" cy="6" r="15" fill="#10b981" />
            <path d="M171 6 l5 5 l9 -10" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </g>
      </g>
      {/* Confetti when they are hired */}
      {Array.from({ length: 14 }, (_, i) => {
        const a = (i / 14) * Math.PI * 2;
        const colors = ['#fbbf24', '#fb8a7e', '#a78bfa', '#34d399', '#f472b6', '#ffffff'];
        return <rect key={i} className="sch-confetti" style={v({ '--dx': `${Math.cos(a) * (90 + (i % 3) * 25)}px`, '--dy': `${Math.sin(a) * (70 + (i % 4) * 18) - 20}px`, '--r': `${i * 47}deg` })} x="652" y="108" width="9" height="14" rx="2" fill={colors[i % colors.length]} />;
      })}
    </g>
  );
}

/* Employee Workspace --------------------------------------------------------------------------------------------- */
function Sky() {
  return (
    <>
      <defs>
        <radialGradient id="sce-sun" cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="#fde68a" /><stop offset=".6" stopColor="#fb923c" /><stop offset="1" stopColor="#f97316" /></radialGradient>
        <filter id="sce-shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="12" floodColor="#4338ca" floodOpacity=".18" /></filter>
      </defs>
      <g className="sce-sun">
        <g className="sce-rays">
          {Array.from({ length: 12 }, (_, i) => <rect key={i} x="696" y="18" width="6" height="22" rx="3" fill="#fb923c" opacity=".55" transform={`rotate(${i * 30} 699 100)`} />)}
        </g>
        <circle cx="699" cy="100" r="50" fill="url(#sce-sun)" />
      </g>
      <g className="sce-cloud" style={v({ '--dur': '26s' })}>
        <path d="M80 70 a26 26 0 0 1 50 -10 a20 20 0 0 1 36 14 a16 16 0 0 1 -4 32 h-80 a18 18 0 0 1 -2 -36z" fill="#ffffff" opacity=".9" />
      </g>
      <g className="sce-cloud" style={v({ '--dur': '34s', '--d': '-12s' })}>
        <path d="M470 40 a20 20 0 0 1 38 -8 a16 16 0 0 1 28 10 a12 12 0 0 1 -3 25 h-60 a14 14 0 0 1 -3 -27z" fill="#ffffff" opacity=".8" />
      </g>
    </>
  );
}

function EmployeeStage() {
  return (
    <g>
      <Sky />
      {/* Check-in */}
      <g className="sce-card" style={v({ '--d': '.35s' })}><g filter="url(#sce-shadow)" transform="translate(40 120)">
        <rect width="300" height="96" rx="24" fill="#ffffff" />
        <circle className="sce-ring" cx="52" cy="48" r="26" fill="none" stroke="#34d399" strokeWidth="3" />
        <circle cx="52" cy="48" r="26" fill="#d1fae5" />
        <path className="sce-tick" d="M40 49 l8 8 l15 -17" fill="none" stroke="#059669" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
        <text x="96" y="42" fill="#1e1b4b" fontSize="20" fontWeight="800">Checked in</text>
        <text x="96" y="68" fill="#6366f1" fontSize="15" fontWeight="600">09:02 · On time</text>
      </g></g>
      {/* Payslip */}
      <g className="sce-card" style={v({ '--d': '.55s' })}><g filter="url(#sce-shadow)" transform="translate(40 236)">
        <rect width="300" height="150" rx="24" fill="#ffffff" />
        <rect x="24" y="24" width="44" height="44" rx="14" fill="#eef2ff" />
        <text x="46" y="54" textAnchor="middle" fill="#4f46e5" fontSize="22" fontWeight="800">₹</text>
        <text x="84" y="44" fill="#1e1b4b" fontSize="18" fontWeight="800">Payslip ready</text>
        <text x="84" y="64" fill="#64748b" fontSize="13">This month</text>
        {[0, 1, 2, 3, 4].map((b) => <rect key={b} className="sce-bar" style={v({ '--d': `${b * 0.15}s` })} x={28 + b * 34} y="88" width="22" height="40" rx="6" fill={b === 4 ? '#fb923c' : '#c7d2fe'} />)}
        <g className="sce-download">
          <circle cx="252" cy="108" r="22" fill="#4f46e5" />
          <path d="M252 97 v16 m-7 -6 l7 7 l7 -7" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </g></g>
      {/* Leave calendar */}
      <g className="sce-card" style={v({ '--d': '.75s' })}><g filter="url(#sce-shadow)" transform="translate(372 150)">
        <rect width="270" height="236" rx="24" fill="#ffffff" />
        <rect width="270" height="54" rx="24" fill="#4f46e5" />
        <rect y="30" width="270" height="24" fill="#4f46e5" />
        <text x="24" y="35" fill="#ffffff" fontSize="17" fontWeight="800">Leave planned</text>
        <text x="246" y="35" textAnchor="end" fill="#c7d2fe" fontSize="14" fontWeight="600">3 days</text>
        {Array.from({ length: 28 }, (_, i) => {
          const x = 24 + (i % 7) * 33;
          const y = 72 + Math.floor(i / 7) * 38;
          const leave = i === 16 || i === 17 || i === 18;
          return leave
            ? <rect key={i} className="sce-leave" style={v({ '--d': `${(i - 16) * 0.35}s` })} x={x} y={y} width="26" height="26" rx="8" fill="#fb923c" />
            : <rect key={i} x={x} y={y} width="26" height="26" rx="8" fill={i === 9 ? '#a5b4fc' : '#eef2ff'} />;
        })}
      </g></g>
      {/* A friendly ping */}
      <g className="sce-bubble"><g transform="translate(664 236)">
        <rect width="120" height="60" rx="20" fill="#34d399" />
        <path d="M24 60 l-6 14 l18 -14z" fill="#34d399" />
        <text x="60" y="37" textAnchor="middle" fill="#064e3b" fontSize="16" fontWeight="800">Approved!</text>
      </g></g>
    </g>
  );
}

function TeamStage() {
  const people: [number, number, string][] = [[400, 150, '#6366f1'], [300, 205, '#fb923c'], [500, 205, '#34d399'], [335, 300, '#f472b6'], [465, 300, '#a78bfa']];
  return (
    <g>
      <Sky />
      <circle cx="400" cy="240" r="128" fill="#ffffff" fillOpacity=".55" stroke="#c7d2fe" strokeWidth="2" strokeDasharray="4 10" className="sct-ring" />
      {people.map(([x, y, c], i) => (
        <g key={i} className="sct-person" style={v({ '--d': `${i * 0.3}s` })}>
          <circle cx={x} cy={y} r="30" fill="#ffffff" filter="url(#sce-shadow)" />
          <circle cx={x} cy={y - 6} r="10" fill={c} />
          <path d={`M${x - 16} ${y + 18} a16 13 0 0 1 32 0z`} fill={c} />
        </g>
      ))}
      <g transform="translate(400 240)">
        <circle r="28" fill="#4f46e5" />
        <text y="6" textAnchor="middle" fill="#fff" fontSize="15" fontWeight="800">Team</text>
      </g>
      {[{ x: 24, y: 120, t: 'Leave request', d: '0s' }, { x: 24, y: 220, t: 'Expense claim', d: '1.2s' }, { x: 576, y: 300, t: 'Attendance fix', d: '2.4s' }].map((r) => (
        <g key={r.t} className="sce-card" style={v({ '--d': '.5s' })}><g filter="url(#sce-shadow)" transform={`translate(${r.x} ${r.y})`}>
          <rect width="200" height="70" rx="20" fill="#ffffff" />
          <text x="20" y="31" fill="#1e1b4b" fontSize="15" fontWeight="800">{r.t}</text>
          <text x="20" y="52" fill="#64748b" fontSize="12.5">Waiting for you</text>
          <g className="sct-approve" style={v({ '--d': r.d })}>
            <circle cx="168" cy="35" r="16" fill="#10b981" />
            <path d="M161 35 l5 5 l9 -10" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </g></g>
      ))}
    </g>
  );
}
