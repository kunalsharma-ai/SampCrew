import { cn } from '../cn';

/**
 * The SampCrew logo ("People, simplified." by SAMPLEDGE). The artwork lives in each app's public/brand folder:
 * - `sampcrew-icon.svg`: the mark alone (three people gathering), animated.
 * - `sampcrew-wordmark-{light,dark}.svg`: the mark with the SampCrew word, for menus and headers.
 * - `sampcrew-logo-{light,dark}.svg`: the full lockup with the tagline, for sign-in pages.
 * "light" artwork is for light backgrounds and "dark" for dark ones; the page shows the one matching the theme
 * (see .crew-logo-on-light / .crew-logo-on-dark in styles.css), unless `tone` forces one.
 */
export function CrewLogo({
  className,
  withWordmark = true,
  subtitle,
  variant = 'wordmark',
  tone = 'auto',
  height,
}: {
  className?: string;
  withWordmark?: boolean;
  subtitle?: string;
  /** wordmark: mark + SampCrew; lockup: the full logo with "People, simplified. | by SAMPLEDGE". */
  variant?: 'wordmark' | 'lockup';
  /** auto follows the theme; light/dark force the artwork for a known background. */
  tone?: 'auto' | 'light' | 'dark';
  /** Image height in pixels. */
  height?: number;
}) {
  if (!withWordmark) {
    const h = height ?? 36;
    return <img src="/brand/sampcrew-icon.svg" alt="SampCrew" width={h} height={h} className={cn('shrink-0', className)} style={{ width: h, height: h }} />;
  }
  const file = variant === 'lockup' ? 'logo' : 'wordmark';
  const h = height ?? (variant === 'lockup' ? 64 : 44);
  // Width from each artwork's view box: 296 x 78 for the lockup, 238 x 78 for the wordmark.
  const w = Math.round((h * (variant === 'lockup' ? 296 : 238)) / 78);
  const img = (t: 'light' | 'dark', cls?: string) => (
    <img src={`/brand/sampcrew-${file}-${t}.svg`} alt="SampCrew" width={w} height={h} className={cn('max-w-full shrink-0', cls)} style={{ height: h, width: 'auto' }} />
  );
  return (
    <span className={cn('inline-flex flex-col items-start leading-none', className)} data-brand="sampcrew">
      {tone === 'auto' ? (
        <>
          {img('light', 'crew-logo-on-light')}
          {img('dark', 'crew-logo-on-dark')}
        </>
      ) : (
        img(tone)
      )}
      {subtitle && <span className="-mt-1 pl-[0.2rem] text-[0.625rem] font-medium uppercase tracking-[0.14em] text-fg-subtle">{subtitle}</span>}
    </span>
  );
}

export function DemoBanner() {
  return (
    <div role="note" className="bg-ember-subtle text-ember text-xs font-medium text-center px-4 py-1.5 border-b border-ember/20">
      Demo workspace. All people, companies and figures here are fictional sample data.
    </div>
  );
}
