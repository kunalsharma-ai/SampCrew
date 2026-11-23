import { WELCOME_SCENE_COOKIE, pickWelcomeScene } from '@crew/contracts';
import { WelcomeScene } from '@crew/ui';
import { cookies } from 'next/headers';
import { Suspense } from 'react';
import { AuthShell } from './welcome';

/**
 * Sign-in, sign-up, password reset and invitations: the level's animated SampCrew welcome beside the form (above it
 * on phones and tablets), the whole page in that workspace's colours. The form never waits for the animation.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const remembered = (await cookies()).get(WELCOME_SCENE_COOKIE)?.value ?? null;
  const form = (
    <main className="flex items-center justify-center px-4 py-10 sm:px-10">
      <div className="w-full max-w-sm animate-slide-up">
        {children}
        <p className="mt-8 text-center text-xs text-fg-subtle">© {new Date().getFullYear()} SAMPLEDGE · Isolated per company, multi-factor sign-in, tamper-evident audit trail</p>
      </div>
    </main>
  );
  const fallback = pickWelcomeScene(null, remembered);
  return (
    <Suspense
      fallback={
        <div className="sc-shell grid min-h-dvh bg-bg lg:grid-cols-[1fr_520px]" data-scene={fallback}>
          <WelcomeScene scene={fallback} className="min-h-56 lg:min-h-dvh" />
          {form}
        </div>
      }
    >
      <AuthShell remembered={remembered}>{form}</AuthShell>
    </Suspense>
  );
}
