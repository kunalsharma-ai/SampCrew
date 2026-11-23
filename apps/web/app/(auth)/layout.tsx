import { WELCOME_SCENE_COOKIE } from '@crew/contracts';
import { cookies } from 'next/headers';
import { AuthShell } from './welcome';

/**
 * Sign-in, sign-up, password reset and invitations: the level's animated SampCrew welcome and greeting beside the
 * sign-in card (above it on phones and tablets), the whole page in that workspace's colours, with light and dark and
 * colour palettes to try. The form never waits for the animation.
 *
 * No Suspense boundary here: the layout reads a cookie, so every sign-in page renders on request and the frame's
 * useSearchParams needs none. A fallback would put the sign-in form in the page twice (once in the fallback, once in
 * the streamed content).
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const remembered = (await cookies()).get(WELCOME_SCENE_COOKIE)?.value ?? null;
  const footer = <>© {new Date().getFullYear()} SAMPLEDGE · Isolated per company, multi-factor sign-in, tamper-evident audit trail</>;
  return (
    <AuthShell remembered={remembered} footer={footer}>{children}</AuthShell>
  );
}
