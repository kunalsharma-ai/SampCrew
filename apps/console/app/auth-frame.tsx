import { CrewLogo } from '@crew/ui';

export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg-subtle p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between">
          <CrewLogo subtitle="Console" />
          <span className="rounded-full bg-ember-subtle px-2 py-0.5 text-[11px] font-medium text-ember">SAMPLEDGE staff only</span>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">{children}</div>
        <p className="mt-4 text-center text-xs text-fg-subtle">Every action in this console is recorded in the platform audit log.</p>
      </div>
    </main>
  );
}
