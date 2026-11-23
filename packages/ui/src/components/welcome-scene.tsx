'use client';
import { WELCOME_COPY, type WelcomeScene as Scene } from '@crew/contracts';
import { Fragment, useEffect, useState, type CSSProperties } from 'react';
import { cn } from '../cn';

/**
 * The animated welcome beside every SampCrew sign-in form. Each level is its own world, in the colours of the product
 * the person is about to enter, with the workspace's name written large so nobody signs in to the wrong place:
 *
 * - console   Super Admin Console: a night-blue command centre, a turning wireframe globe with satellites and a radar
 *             sweep, live status panels and a scan line.
 * - super     Super Workspace: emerald and gold, a crowned core with HR Workspaces orbiting it, data flowing along gold
 *             links and a twinkling starfield.
 * - hr        HR Workspace: violet and coral, a hiring board where a candidate card travels Applied, Interview, Hired
 *             and lands in a burst of confetti, over slowly morphing colour blobs.
 * - employee  Employee Workspace: a warm daylight scene, a rising sun and drifting clouds, a check-in that ticks, leave
 *             days filling the calendar and a payslip ready to download.
 * - team      Employee Workspace of someone people report to: the same daylight, with their team gathering and
 *             requests being approved.
 *
 * The official logo is shown unchanged. Only transform and opacity move, so it stays smooth on slow machines; with
 * reduced motion it is a still composition. Decoration is hidden from screen readers and the words are real text.
 * The form beside it is usable from the first frame: nothing waits for the animation.
 */
export function WelcomeScene({
  scene,
  logoSrc,
  choices,
  className,
  heading: Heading = 'h1',
}: {
  scene: Scene;
  /** The workspace name's element: h1 when the form beside it uses h2 (Web Portal), h2 when the form has the h1 (Console). */
  heading?: 'h1' | 'h2';
  /** Defaults to the official logo for a dark or light backdrop, whichever this level's world uses. */
  logoSrc?: string;
  /** Links to the other levels' sign-in ("Signing in to: Super Workspace · HR Workspace · Employee Workspace"). */
  choices?: { label: string; href: string; active: boolean; scene?: Scene }[];
  className?: string;
}) {
  const copy = WELCOME_COPY[scene];
  const light = scene === 'employee' || scene === 'team';
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
  return (
    <section className={cn('sc-scene', quick && 'sc-quick', className)} data-scene={scene} data-testid="welcome-scene" aria-label={`${copy.level} welcome`}>
      <Backdrop scene={scene} />
      <div className="sc-content">
        <div className="sc-top">
          <img src={logoSrc ?? `/brand/sampcrew-logo-${light ? 'light' : 'dark'}.svg`} alt="SampCrew" className="sc-logo" width={243} height={64} />
        </div>
        <div className="sc-copy">
          <p className="sc-eyebrow"><span className="sc-eyebrow-dot" aria-hidden />You are signing in to</p>
          <Heading className="sc-name" data-testid="welcome-level">
            {words.map((w, i) => (
              <Fragment key={w + i}>
                <span className="sc-word-mask"><span className="sc-word" style={{ '--i': i } as CSSProperties}>{w}</span></span>
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
        <div className="sc-stage" aria-hidden>
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
