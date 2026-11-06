'use client';
import { Info } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../cn';
import { type HelpContent, type HelpEntry, type HelpKind, resolveHelp } from '../help-resolve';

export type { HelpContent, HelpEntry, HelpKind } from '../help-resolve';

interface HelpContextValue {
  content: HelpContent;
  pathname: string;
}

const HelpContext = createContext<HelpContextValue | null>(null);

/**
 * Makes an app's help content available to every "i" icon below it. `pathname` is the current route, so page
 * help and page-specific overrides follow navigation. Without a provider no icons are shown.
 */
export function HelpProvider({ content, pathname, children }: { content: HelpContent; pathname: string; children: ReactNode }) {
  const value = useMemo(() => ({ content, pathname }), [content, pathname]);
  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

/** The help entry for something on screen, from the nearest HelpProvider; undefined when there is none. */
export function useHelp(kind: HelpKind, text?: string): HelpEntry | undefined {
  const ctx = useContext(HelpContext);
  if (!ctx) return undefined;
  return resolveHelp(ctx.content, kind, ctx.pathname, text);
}

/** Help passed straight to a component: an entry, false to hide the icon, or undefined to look it up. */
export type HelpProp = HelpEntry | false | undefined;

/**
 * An "i" icon that shows an entry from the app's help content: for a page (by route), a section heading, a form
 * field or a navigation group (by its visible text). Renders nothing when there is no entry.
 * `describedBy` is the id of the visible heading or label it sits next to, which screen readers announce with it.
 */
export function AutoHelp({ kind, text, help, className, describedBy }: { kind: HelpKind; text?: ReactNode; help?: HelpProp; className?: string; describedBy?: string }) {
  const plain = typeof text === 'string' ? text : undefined;
  const found = useHelp(kind, plain);
  const entry = help === false ? undefined : help ?? found;
  if (!entry) return null;
  return <InfoTip entry={entry} kind={kind} title={entry.title ?? plain} describedBy={describedBy} className={className} />;
}

const NOUN: Record<HelpKind, string> = { page: 'page', section: 'section', field: 'field', module: 'module' };

const HOVER_OPEN_MS = 120;
const HOVER_CLOSE_MS = 180;
const GAP = 6;
const GUTTER = 8;

function supportsPopover(el: HTMLElement | null): el is HTMLElement & { showPopover(): void; hidePopover(): void } {
  return !!el && typeof (el as { showPopover?: unknown }).showPopover === 'function';
}

/**
 * The "i" button and its help bubble.
 *
 * - Mouse: hover to peek; click to keep it open.
 * - Touch: tap to open, tap again or anywhere else to close.
 * - Keyboard: Enter or Space opens it and moves focus into the bubble so screen readers read it; Escape closes it and
 *   returns focus to the button; Tab carries on to the next control and closes it.
 *
 * The button's name is "More about this field" (or section, page, module) rather than the field's own label, so a
 * label, a voice command or a test that names a control still finds exactly one control; the label it sits next to
 * is announced as its description.
 *
 * The bubble uses the browser's popover top layer, so it shows above cards, scroll areas and modal dialogs, and it
 * stays right after the button in the page order, which is where a screen reader expects it.
 */
export function InfoTip({ entry, kind = 'section', title, describedBy, className }: { entry: HelpEntry; kind?: HelpKind; title?: string; describedBy?: string; className?: string }) {
  const id = useId();
  const heading = entry.title ?? title ?? `About this ${NOUN[kind]}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const focusOnOpen = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };

  const close = useCallback((returnFocus = false) => {
    clearTimer();
    pinned.current = false;
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const btn = buttonRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const r = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(320, vw - GUTTER * 2);
    pop.style.width = `${width}px`;
    const left = Math.max(GUTTER, Math.min(r.left + r.width / 2 - 20, vw - width - GUTTER));
    const h = pop.offsetHeight;
    let top = r.bottom + GAP;
    if (top + h > vh - GUTTER && r.top - GAP - h >= GUTTER) top = r.top - GAP - h;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(Math.max(GUTTER, top))}px`;
  }, []);

  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    if (open) {
      if (supportsPopover(pop) && !pop.matches(':popover-open')) pop.showPopover();
      place();
      if (focusOnOpen.current) {
        focusOnOpen.current = false;
        pop.focus({ preventScroll: true });
      }
    } else if (supportsPopover(pop) && pop.matches(':popover-open')) {
      pop.hidePopover();
    }
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (buttonRef.current?.contains(t) || popRef.current?.contains(t))) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Only this bubble closes, not a dialog it sits in.
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    };
    const onMove = () => place();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, close, place]);

  useEffect(() => clearTimer, []);

  const peek = (next: boolean) => {
    if (pinned.current) return;
    clearTimer();
    timer.current = setTimeout(() => setOpen(next), next ? HOVER_OPEN_MS : HOVER_CLOSE_MS);
  };

  return (
    <span className={cn('crew-help inline-flex shrink-0 align-middle', className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`More about this ${NOUN[kind]}`}
        aria-describedby={describedBy}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        data-help-trigger=""
        onPointerEnter={(e) => e.pointerType === 'mouse' && peek(true)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && peek(false)}
        onClick={(e) => {
          clearTimer();
          // A keyboard press has no pointer position (detail 0): move focus into the bubble so it is read out.
          const keyboard = e.detail === 0;
          if (open && (pinned.current || keyboard)) return close();
          pinned.current = true;
          focusOnOpen.current = keyboard;
          if (open && keyboard) popRef.current?.focus({ preventScroll: true });
          setOpen(true);
        }}
        className="crew-help-trigger -my-1 inline-flex size-6 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-accent-subtle hover:text-accent focus:outline-none focus-visible:ring-3 focus-visible:ring-accent/40 aria-expanded:text-accent"
      >
        <Info className="size-3.5" aria-hidden strokeWidth={2.25} />
      </button>
      <div
        ref={popRef}
        id={id}
        popover="manual"
        role="dialog"
        aria-labelledby={open ? `${id}-title` : undefined}
        tabIndex={-1}
        data-help-pop=""
        hidden={!open}
        onPointerEnter={(e) => e.pointerType === 'mouse' && clearTimer()}
        onPointerLeave={(e) => e.pointerType === 'mouse' && peek(false)}
        onKeyDown={(e) => {
          if (e.key === 'Tab') close();
        }}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (next && (buttonRef.current?.contains(next) || popRef.current?.contains(next))) return;
          if (next) close();
        }}
        className="crew-help-pop fixed z-[90] m-0 max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-surface-raised p-3.5 text-left text-[0.8125rem] font-normal normal-case leading-relaxed tracking-normal text-fg shadow-pop focus:outline-none"
        style={{ inset: 'auto' }}
      >
        {open && <HelpBody entry={entry} heading={heading} titleId={`${id}-title`} />}
      </div>
    </span>
  );
}

function HelpBody({ entry, heading, titleId }: { entry: HelpEntry; heading: string; titleId: string }) {
  return (
    <>
      <p className="flex items-center gap-1.5 font-semibold text-fg">
        <Info className="size-3.5 shrink-0 text-accent" aria-hidden />
        <span id={titleId}>{heading}</span>
      </p>
      <dl className="mt-2 space-y-2">
        <div>
          <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-accent">What it is for</dt>
          <dd className="mt-0.5 text-fg-muted">{entry.what}</dd>
        </div>
        {entry.how && (
          <div>
            <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-accent">How to use it</dt>
            <dd className="mt-0.5 text-fg-muted">{entry.how}</dd>
          </div>
        )}
        {entry.where && (
          <div>
            <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-accent">Where and when</dt>
            <dd className="mt-0.5 text-fg-muted">{entry.where}</dd>
          </div>
        )}
      </dl>
    </>
  );
}
