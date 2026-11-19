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

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

/** Call once on mount: the first user gesture unlocks audio for the rest of the visit. */
export function armAudioUnlock(): () => void {
  if (typeof window === 'undefined' || unlocked) return () => undefined;
  const unlock = () => {
    const c = context();
    if (c && c.state === 'suspended') void c.resume();
    unlocked = true;
    remove();
  };
  const remove = () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
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
export function playNotificationSound(priority: NotificationPriority, volume: number, opts: { fromGesture?: boolean } = {}): boolean {
  if (!opts.fromGesture && !unlocked) return false;
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
