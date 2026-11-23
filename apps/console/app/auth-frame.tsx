import { CrewLogo, WelcomeScene } from '@crew/ui';

/**
 * Console sign-in and account pages: the Console's own animated welcome (orbiting rings, radar sweep, the SampCrew
 * logo) beside the form, above it on small screens. The form is usable at once.
 */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-bg-subtle lg:grid-cols-[1fr_480px]">
      <WelcomeScene scene="console" heading="h2" className="min-h-56 lg:min-h-dvh" />
      <main className="grid place-items-center p-6">
        <div className="w-full max-w-sm animate-slide-up">
          <div className="mb-6 flex items-center justify-between">
            <CrewLogo subtitle="Console" />
            <span className="rounded-full bg-ember-subtle px-2 py-0.5 text-[11px] font-medium text-ember">SAMPLEDGE staff only</span>
          </div>
          <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">{children}</div>
          <p className="mt-4 text-center text-xs text-fg-subtle">Every action in this console is recorded in the platform audit log.</p>
        </div>
      </main>
    </div>
  );
}
