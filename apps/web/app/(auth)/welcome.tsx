'use client';
import { pickWelcomeScene, WORKSPACE_WELCOME_CHOICES } from '@crew/contracts';
import { WelcomeScene } from '@crew/ui';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * The level's animated welcome beside the sign-in pages. The level comes from the address (?space=hr), else from the
 * last level this browser signed in to (a cookie the signed-in shell writes), else the Employee Workspace. The sign-in
 * page offers the other levels as links, so someone on a shared computer can switch.
 */
export function WelcomeFromUrl({ remembered }: { remembered: string | null }) {
  const sp = useSearchParams();
  const path = usePathname();
  const scene = pickWelcomeScene(sp.get('space'), remembered);
  const choices = path === '/login'
    ? WORKSPACE_WELCOME_CHOICES.map((c) => {
        const q = new URLSearchParams(sp.toString());
        q.set('space', c.scene);
        return { label: c.label, href: `/login?${q}`, active: c.scene === scene || (c.scene === 'employee' && scene === 'team') };
      })
    : undefined;
  return <WelcomeScene scene={scene} choices={choices} className="min-h-56 lg:min-h-dvh" />;
}
