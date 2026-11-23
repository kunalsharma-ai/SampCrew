'use client';
import { WELCOME_COPY, type WelcomeScene as Scene } from '@crew/contracts';
import { useEffect, useState } from 'react';
import { cn } from '../cn';

/**
 * The animated SampCrew welcome beside every sign-in form. The official logo (public/brand, unchanged artwork and
 * proportions) rises onto a softly lit, slightly tilted glass card; behind it each level has its own motion:
 *
 * - console: orbiting rings and a slow radar sweep (authority over every workspace)
 * - super: an organisation network that draws itself (structure, HR Workspaces, modules)
 * - hr: rising bars and candidate cards (recruitment and HR operations moving)
 * - team: three groups gathering around a centre, with approvals ticking (a team working together)
 * - employee: light bubbles, a clock and a calendar (attendance, leave, a friendly day)
 *
 * Only transform and opacity move, so it stays smooth on slow machines; nothing moves when the person prefers reduced
 * motion (then it is a still composition). Everything decorative is hidden from screen readers; the welcome text is
 * real text. The form beside it is usable from the first frame: nothing waits for the animation.
 */
export function WelcomeScene({
  scene,
  logoSrc = '/brand/sampcrew-logo-dark.svg',
  choices,
  className,
  heading: Heading = 'h1',
}: {
  scene: Scene;
  /** The welcome headline's element: h1 when the form below uses h2 (Web Portal), h2 when the form has the h1 (Console). */
  heading?: 'h1' | 'h2';
  logoSrc?: string;
  /** Links to the other levels' sign-in ("Signing in to: Super Workspace · HR Workspace · Employee Workspace"). */
  choices?: { label: string; href: string; active: boolean }[];
  className?: string;
}) {
  const copy = WELCOME_COPY[scene];
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
  return (
    <section className={cn('sc-scene', quick && 'sc-quick', className)} data-scene={scene} data-testid="welcome-scene" aria-label={`${copy.level} welcome`}>
      <div className="sc-bg" aria-hidden>
        <span className="sc-aurora sc-aurora-1" />
        <span className="sc-aurora sc-aurora-2" />
        <span className="sc-aurora sc-aurora-3" />
        <span className="sc-floor" />
        <Motif scene={scene} />
      </div>
      <div className="sc-content">
        <div className="sc-logo-stage" aria-hidden>
          <span className="sc-halo" />
          <div className="sc-logo-card">
            <img src={logoSrc} alt="" className="sc-logo" width={296} height={78} />
            <span className="sc-sweep" />
          </div>
        </div>
        <div className="sc-copy">
          <p className="sc-level" data-testid="welcome-level"><span className="sc-level-dot" aria-hidden />{copy.level}</p>
          <Heading className="sc-title" data-testid="welcome-title">{copy.title}</Heading>
          <p className="sc-message">{copy.message}</p>
          <ul className="sc-highlights" aria-label="In this workspace">
            {copy.highlights.map((h) => <li key={h}>{h}</li>)}
          </ul>
          {choices && choices.length > 1 && (
            <nav className="sc-choices" aria-label="Choose where you are signing in">
              <span>Signing in to</span>
              {choices.map((c) => (
                <a key={c.href} href={c.href} aria-current={c.active ? 'page' : undefined} className={cn(c.active && 'sc-choice-active')} data-testid="welcome-choice">{c.label}</a>
              ))}
            </nav>
          )}
        </div>
        <p className="sc-foot">SampCrew · People, simplified. · by SAMPLEDGE</p>
      </div>
    </section>
  );
}

/** Each level's moving background, drawn in SVG with the SampCrew colours. */
function Motif({ scene }: { scene: Scene }) {
  return (
    <svg className="sc-motif" viewBox="0 0 600 600" preserveAspectRatio="xMidYMid slice" focusable="false">
      <defs>
        <linearGradient id="sc-g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#FB7185" /><stop offset="1" stopColor="#F472B6" /></linearGradient>
        <linearGradient id="sc-g2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#F472B6" /><stop offset="1" stopColor="#8B5CF6" /></linearGradient>
        <linearGradient id="sc-g3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7B4DFF" /><stop offset="1" stopColor="#0BC5FF" /></linearGradient>
      </defs>
      {scene === 'console' && <ConsoleMotif />}
      {scene === 'super' && <SuperMotif />}
      {scene === 'hr' && <HrMotif />}
      {scene === 'team' && <TeamMotif />}
      {scene === 'employee' && <EmployeeMotif />}
    </svg>
  );
}

function ConsoleMotif() {
  return (
    <g>
      {[110, 175, 240].map((r, i) => (
        <g key={r} className={`sc-spin sc-spin-${i + 1}`}>
          <circle cx="300" cy="300" r={r} fill="none" stroke="url(#sc-g3)" strokeOpacity={0.35 - i * 0.08} strokeWidth="1.2" strokeDasharray={i === 1 ? '2 10' : undefined} />
          <circle cx={300 + r} cy="300" r={5 - i} fill={i === 0 ? '#FB7185' : i === 1 ? '#8B5CF6' : '#0BC5FF'} />
          <circle cx={300 - r * 0.6} cy={300 + r * 0.8} r="2.5" fill="#F472B6" opacity=".8" />
        </g>
      ))}
      <path className="sc-radar" d="M300 300 L550 260 A253 253 0 0 1 550 340 Z" fill="url(#sc-g2)" opacity=".12" />
      <circle cx="300" cy="300" r="6" fill="#fff" opacity=".85" />
    </g>
  );
}

function SuperMotif() {
  const nodes: [number, number, string][] = [[300, 140, 'url(#sc-g1)'], [170, 260, 'url(#sc-g2)'], [430, 260, 'url(#sc-g2)'], [110, 400, 'url(#sc-g3)'], [240, 410, 'url(#sc-g3)'], [360, 410, 'url(#sc-g3)'], [490, 400, 'url(#sc-g3)'], [300, 520, 'url(#sc-g1)']];
  const links: [number, number][] = [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5], [2, 6], [4, 7], [5, 7]];
  return (
    <g>
      {links.map(([a, b], i) => (
        <line key={i} className="sc-draw" style={{ animationDelay: `${0.3 + i * 0.18}s` }} x1={nodes[a]![0]} y1={nodes[a]![1]} x2={nodes[b]![0]} y2={nodes[b]![1]} stroke="url(#sc-g2)" strokeOpacity=".55" strokeWidth="1.5" pathLength={1} />
      ))}
      {nodes.map(([x, y, f], i) => (
        <g key={i} className="sc-node" style={{ animationDelay: `${0.2 + i * 0.22}s`, transformOrigin: `${x}px ${y}px` }}>
          <circle cx={x} cy={y} r={i === 0 ? 16 : i < 3 ? 12 : 9} fill={f} opacity=".85" />
          <circle cx={x} cy={y} r={i === 0 ? 28 : 20} fill="none" stroke="#fff" strokeOpacity=".12" />
        </g>
      ))}
    </g>
  );
}

function HrMotif() {
  return (
    <g>
      <g transform="translate(90 520)">
        {[0, 1, 2, 3, 4].map((i) => (
          <rect key={i} className="sc-bar" style={{ animationDelay: `${i * 0.25}s` }} x={i * 46} y={-200} width="28" height="200" rx="8" fill={i % 2 ? 'url(#sc-g2)' : 'url(#sc-g3)'} opacity=".55" />
        ))}
      </g>
      {[[400, 380, 0], [470, 250, 1.2], [360, 170, 2.4]].map(([x, y, d], i) => (
        <g key={i} className="sc-card" style={{ animationDelay: `${d}s` }}>
          <rect x={x} y={y} width="150" height="58" rx="14" fill="#fff" fillOpacity=".08" stroke="#fff" strokeOpacity=".18" />
          <circle cx={(x as number) + 26} cy={(y as number) + 29} r="14" fill={i === 1 ? 'url(#sc-g1)' : 'url(#sc-g2)'} />
          <rect x={(x as number) + 50} y={(y as number) + 18} width="78" height="7" rx="3.5" fill="#fff" opacity=".45" />
          <rect x={(x as number) + 50} y={(y as number) + 33} width="52" height="6" rx="3" fill="#fff" opacity=".25" />
        </g>
      ))}
    </g>
  );
}

function TeamMotif() {
  const groups: [number, number][] = [[300, 170], [170, 390], [430, 390]];
  return (
    <g>
      <g className="sc-spin sc-spin-slow" style={{ transformOrigin: '300px 320px' }}>
        <circle cx="300" cy="320" r="150" fill="none" stroke="url(#sc-g2)" strokeOpacity=".25" strokeDasharray="3 9" />
      </g>
      {groups.map(([x, y], i) => (
        <g key={i} className="sc-gather" style={{ animationDelay: `${i * 0.35}s`, ['--gx' as string]: `${(x - 300) * 0.25}px`, ['--gy' as string]: `${(y - 320) * 0.25}px` }}>
          <circle cx={x} cy={y - 14} r="18" fill="url(#sc-g1)" opacity=".7" />
          <circle cx={x - 15} cy={y + 12} r="18" fill="url(#sc-g2)" opacity=".7" />
          <circle cx={x + 15} cy={y + 12} r="18" fill="url(#sc-g3)" opacity=".7" />
        </g>
      ))}
      {[[230, 270], [372, 268], [300, 455]].map(([x, y], i) => (
        <g key={i} className="sc-tick" style={{ animationDelay: `${1.2 + i * 1.1}s`, transformOrigin: `${x}px ${y}px` }}>
          <circle cx={x} cy={y} r="13" fill="#fff" fillOpacity=".12" stroke="#fff" strokeOpacity=".35" />
          <path d={`M${(x as number) - 5} ${y} l4 4 l7 -8`} fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ))}
    </g>
  );
}

function EmployeeMotif() {
  return (
    <g>
      {[[90, 560, 22, 0], [190, 600, 14, 1.5], [300, 580, 30, 3], [420, 610, 18, 0.8], [520, 570, 24, 2.2], [250, 640, 12, 4]].map(([x, y, r, d], i) => (
        <circle key={i} className="sc-bubble" style={{ animationDelay: `${d}s` }} cx={x} cy={y} r={r} fill={i % 3 === 0 ? 'url(#sc-g1)' : i % 3 === 1 ? 'url(#sc-g2)' : 'url(#sc-g3)'} opacity=".45" />
      ))}
      <g>
        <circle cx="450" cy="170" r="46" fill="#fff" fillOpacity=".06" stroke="#fff" strokeOpacity=".25" strokeWidth="2" />
        <line className="sc-hand" x1="450" y1="170" x2="450" y2="140" stroke="#FB7185" strokeWidth="3" strokeLinecap="round" />
        <line x1="450" y1="170" x2="470" y2="170" stroke="#fff" strokeOpacity=".7" strokeWidth="3" strokeLinecap="round" />
        <circle cx="450" cy="170" r="4" fill="#fff" />
      </g>
      <g transform="translate(90 120)" className="sc-float">
        <rect width="120" height="104" rx="16" fill="#fff" fillOpacity=".06" stroke="#fff" strokeOpacity=".22" />
        <rect width="120" height="26" rx="13" fill="url(#sc-g2)" opacity=".7" />
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <rect key={i} x={14 + (i % 3) * 34} y={36 + Math.floor(i / 3) * 21} width="24" height="13" rx="4" fill="#fff" opacity={i === 4 ? 0.85 : 0.18} />
        ))}
      </g>
    </g>
  );
}
