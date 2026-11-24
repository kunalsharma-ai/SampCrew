'use client';
import { pickWelcomeScene, WORKSPACE_WELCOME_CHOICES } from '@crew/contracts';
import { SignInFrame } from '@crew/ui';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * The sign-in pages' frame: the level's animated welcome and greeting, and the sign-in card in that level's colours,
 * with light, dark and colour palette choices. The level comes from the address (?space=hr), else from the last
 * level this browser signed in to (a cookie the signed-in shell writes), else the Employee Workspace. The sign-in
 * page offers the other levels as links, so someone on a shared computer can switch.
 */
export function AuthShell({ remembered, footer, children }: { remembered: string | null; footer: React.ReactNode; children: React.ReactNode }) {
  const sp = useSearchParams();
  const path = usePathname();
  const scene = pickWelcomeScene(sp.get('space'), remembered);
  const choices = path === '/login'
    ? WORKSPACE_WELCOME_CHOICES.map((c) => {
        const q = new URLSearchParams(sp.toString());
        q.set('space', c.scene);
        return { label: c.label, href: `/login?${q}`, scene: c.scene, active: c.scene === scene || (c.scene === 'employee' && scene === 'team') };
      })
    : undefined;
  return <SignInFrame scene={scene} choices={choices} footer={footer} helpHref="/help-and-support">{children}</SignInFrame>;
}
