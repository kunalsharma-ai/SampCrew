import { SignInFrame } from '@crew/ui';

/**
 * Console sign-in and account pages (SAMPLEDGE staff only): the Super Admin Console's own animated world and
 * greeting (a command centre with a turning globe, satellites and live status panels) beside the sign-in card, above
 * it on small screens, with light and dark and colour palettes to try. The form is usable at once.
 */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <SignInFrame scene="console" heading="h2" footer="Every action in this console is recorded in the platform audit log.">
      {children}
    </SignInFrame>
  );
}
