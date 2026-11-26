'use client';
import type { NotificationPriority } from '@crew/contracts';

/**
 * Short, quiet notification tones made with the Web Audio API (no audio files to download). Browsers only allow
 * sound after the person has interacted with the page, so the audio context is created on their first click or key
 * press and nothing ever plays when a page loads: sounds play only for notices that arrive while the page is open,
 * and only when the person switched sound on (Settings > Notifications).
 */
let ctx: AudioContext | null = null;
let unlocked = false;
/** A tone held back because the browser did not allow sound yet; it plays at the person's next click or key press. */
let pending: { priority: NotificationPriority; volume: number; at: number } | null = null;
/** How long a held-back tone stays worth playing. */
const PENDING_MS = 2 * 60_000;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

/** Gestures browsers accept for starting sound (touchend for phones and tablets, where pointerdown may not count). */
const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'click', 'touchend'] as const;

/** Call once on mount: the first user gesture unlocks audio for the rest of the visit. */
export function armAudioUnlock(): () => void {
  if (typeof window === 'undefined' || unlocked) return () => undefined;
  const unlock = () => {
    const c = context();
    if (c && c.state === 'suspended') void c.resume();
    unlocked = true;
    remove();
    // A notice arrived before sound was allowed: its tone plays now, once, if it is still recent.
    const p = pending;
    pending = null;
    if (p && Date.now() - p.at < PENDING_MS) playNotificationSound(p.priority, p.volume);
  };
  const remove = () => {
    for (const e of UNLOCK_EVENTS) window.removeEventListener(e, unlock);
  };
  for (const e of UNLOCK_EVENTS) window.addEventListener(e, unlock, { once: true });
  return remove;
}

/** Notes (Hz) per priority: one soft note for low, rising notes as it gets more important. */
const TONES: Record<NotificationPriority, number[]> = {
  low: [660],
  normal: [660, 880],
  high: [587, 784, 988],
  urgent: [880, 660, 880, 660],
};

/**
 * Plays the tone for a priority at a volume from 0 to 100. Returns false when the browser does not allow sound yet
 * (the person has not interacted with the page); a preview button counts as that interaction.
 */
export function playNotificationSound(priority: NotificationPriority, volume: number, opts: { fromGesture?: boolean; queueIfLocked?: boolean } = {}): boolean {
  if (!opts.fromGesture && !unlocked) {
    // Only the newest held-back tone is kept, so a burst of notices never plays a burst of sounds later.
    if (opts.queueIfLocked && volume > 0) pending = { priority, volume, at: Date.now() };
    return false;
  }
  const c = context();
  if (!c) return false;
  if (c.state === 'suspended') void c.resume();
  if (opts.fromGesture) unlocked = true;
  const gain = Math.max(0, Math.min(100, volume)) / 100;
  if (gain === 0) return false;
  const start = c.currentTime + 0.02;
  TONES[priority].forEach((freq, i) => {
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = start + i * 0.14;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.18 * gain, t + 0.015);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(amp).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.25);
  });
  return true;
}

const TAB = Math.random().toString(36).slice(2);
const played = new Map<string, number>();

/**
 * Whether this tab should sound for a notice: a notice sounds once, in one tab, however many SampCrew tabs are open,
 * and a folded notice that only counts up again (more chat messages from the same person) sounds at most once a
 * minute. Resolves after about 150 ms. Uses localStorage to agree between tabs; without it (private mode) each tab decides for itself.
 */
export async function claimNotice(id: string, folded = false): Promise<boolean> {
  const now = Date.now();
  const last = played.get(id);
  if (last && (!folded || now - last < 60_000)) return false;
  played.set(id, now);
  if (played.size > 200) played.delete(played.keys().next().value!);
  try {
    const key = `crew-sound:${id}`;
    const prev = window.localStorage.getItem(key);
    if (prev && prev.split('|')[0] !== TAB && now - Number(prev.split('|')[1]) < 60_000) return false;
    window.localStorage.setItem(key, `${TAB}|${now}`);
    // Drop old claims so storage does not grow.
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (k?.startsWith('crew-sound:') && now - Number(window.localStorage.getItem(k)?.split('|')[1] ?? 0) > 10 * 60_000) window.localStorage.removeItem(k);
    }
    // Every open tab writes its claim as the notice arrives; after a short wait the last writer is the one that plays.
    await new Promise((r) => setTimeout(r, 150));
    return window.localStorage.getItem(key)?.startsWith(`${TAB}|`) ?? true;
  } catch {
    return true;
  }
}
