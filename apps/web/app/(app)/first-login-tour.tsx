'use client';
import { TOUR_DAYS, TOUR_STEPS, type ExperienceState, type TourStep } from '@crew/contracts';
import { Button } from '@crew/ui';
import { X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { saveExperienceAction } from './experience-actions';

type Box = { top: number; left: number; width: number; height: number };

/** The element a stop points at (data-tour="..."); a display: contents wrapper is measured by its child. */
function boxOf(step: TourStep): Box | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${step}"]`);
  if (!el) return null;
  let r = el.getBoundingClientRect();
  if (!r.width && el.firstElementChild) r = el.firstElementChild.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/**
 * The first-login tour (issue #86): a few stops around the screen (menu, search, My Workforce / My Day,
 * notifications, profile and settings, Home). Skip ends it; it also ends by itself TOUR_DAYS days after it was first
 * shown. Progress is saved, so it resumes where the person left off on another page or device.
 */
export function FirstLoginTour({ experience, canSwitch }: { experience: ExperienceState; canSwitch: boolean }) {
  const [ended, setEnded] = useState(Boolean(experience.tour.endedAt));
  const [seen, setSeen] = useState<TourStep[]>(experience.tour.seen);
  const steps = useMemo(() => TOUR_STEPS.filter((s) => s.key !== 'view' || canSwitch), [canSwitch]);
  const current = steps.find((s) => !seen.includes(s.key)) ?? null;
  const [box, setBox] = useState<Box | null>(null);
  // Browser automation (the end-to-end suites) drives pages without a person to read the tour, so it stays out of the
  // way there unless a test asks for it (localStorage crew-tour = on).
  const [automated, setAutomated] = useState(true);
  useEffect(() => {
    let forced = false;
    try { forced = localStorage.getItem('crew-tour') === 'on'; } catch {}
    setAutomated(Boolean(navigator.webdriver) && !forced);
  }, []);

  useEffect(() => {
    if (!automated && !ended && !experience.tour.startedAt) void saveExperienceAction({ tour: { action: 'start' } });
  }, [automated, ended, experience.tour.startedAt]);

  const measure = useCallback(() => setBox(current ? boxOf(current.key) : null), [current]);
  useLayoutEffect(() => {
    if (automated || ended || !current) return;
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [automated, ended, current, measure]);

  if (automated || ended || !current) return null;
  const index = steps.indexOf(current);
  const last = index === steps.length - 1;
  const next = () => {
    const step = current.key;
    setSeen((x) => [...x, step]);
    if (last) { setEnded(true); void saveExperienceAction({ tour: { action: 'finish' } }); }
    else void saveExperienceAction({ tour: { action: 'seen', step } });
  };
  const skip = () => { setEnded(true); void saveExperienceAction({ tour: { action: 'skip' } }); };

  // Next to the element: below it when there is room, else beside it; centred when it is not on screen.
  const W = 320;
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  let style: React.CSSProperties = { left: Math.max(16, (vw - W) / 2), top: Math.max(16, vh / 2 - 90) };
  if (box) {
    const tall = box.height > vh * 0.6;
    if (tall) style = { left: Math.min(box.left + box.width + 12, vw - W - 16), top: Math.min(Math.max(16, box.top + 80), vh - 220) };
    else style = { left: Math.min(Math.max(16, box.left + box.width / 2 - W / 2), vw - W - 16), top: box.top + box.height + 12 > vh - 200 ? Math.max(16, box.top - 200) : box.top + box.height + 12 };
  }
  const startedAt = experience.tour.startedAt ? Date.parse(experience.tour.startedAt) : Date.now();
  const daysLeft = Math.max(1, Math.ceil((startedAt + TOUR_DAYS * 86_400_000 - Date.now()) / 86_400_000));

  return (
    <div className="pointer-events-none fixed inset-0 z-[60] print:hidden" data-testid="tour">
      {box && (
        <div aria-hidden className="absolute rounded-xl ring-2 ring-accent ring-offset-2 ring-offset-bg transition-all duration-200"
          style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8, boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.35)' }} />
      )}
      {!box && <div aria-hidden className="absolute inset-0 bg-black/35" />}
      <div role="dialog" aria-modal="false" aria-labelledby="tour-title" className="pointer-events-auto absolute w-80 rounded-2xl border border-border bg-surface-raised p-4 shadow-pop animate-fade-in" style={style}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-accent">Tour · {index + 1} of {steps.length}</div>
            <h2 id="tour-title" className="mt-0.5 text-[0.9375rem] font-semibold">{current.title}</h2>
          </div>
          <button type="button" onClick={skip} className="rounded-md p-1 text-fg-subtle hover:bg-bg-subtle hover:text-fg" aria-label="Skip the tour"><X className="size-4" /></button>
        </div>
        <p className="mt-1.5 text-[0.8125rem] text-fg-muted">{current.text}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[0.6875rem] text-fg-subtle">Ends by itself in {daysLeft} day{daysLeft === 1 ? '' : 's'}</span>
          <span className="flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={skip} data-testid="tour-skip">Skip tour</Button>
            <Button size="sm" onClick={next} data-testid="tour-next">{last ? 'Finish' : 'Next'}</Button>
          </span>
        </div>
      </div>
    </div>
  );
}
