import { WelcomeScene } from '@crew/ui';
import { WELCOME_SCENE_COOKIE, pickWelcomeScene } from '@crew/contracts';
import { cookies } from 'next/headers';
import { Suspense } from 'react';
import { WelcomeFromUrl } from './welcome';

/**
 * Sign-in, sign-up, password reset and invitations: the level's animated SampCrew welcome beside the form (above it
 * on phones and tablets). The form never waits for the animation.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const remembered = (await cookies()).get(WELCOME_SCENE_COOKIE)?.value ?? null;
  return (
    <div className="grid min-h-dvh bg-bg lg:grid-cols-[1fr_520px]">
      <Suspense fallback={<WelcomeScene scene={pickWelcomeScene(null, remembered)} className="min-h-56 lg:min-h-dvh" />}>
        <WelcomeFromUrl remembered={remembered} />
      </Suspense>
      <main className="flex items-center justify-center px-4 py-10 sm:px-10">
        <div className="w-full max-w-sm animate-slide-up">
          {children}
          <p className="mt-8 text-center text-xs text-fg-subtle">© {new Date().getFullYear()} SAMPLEDGE · Isolated per company, multi-factor sign-in, tamper-evident audit trail</p>
        </div>
      </main>
    </div>
  );
}
