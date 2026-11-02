import { CrewLogo } from '@crew/ui';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_520px]">
      <aside className="relative hidden overflow-hidden bg-[#0f0d2e] p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -left-24 -top-24 size-[520px] rounded-full bg-[radial-gradient(circle,rgba(99,102,241,0.55),transparent_65%)]" />
        <div className="pointer-events-none absolute -bottom-40 right-0 size-[520px] rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.30),transparent_65%)]" />
        <div className="relative flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" className="size-8" aria-hidden><rect width="32" height="32" rx="9" fill="#6366f1" /><circle cx="11" cy="13" r="4" fill="#fff" /><circle cx="21" cy="13" r="4" fill="#fff" opacity=".7" /><path d="M5.5 25c1.4-4 4.6-6 8.5-6s7.1 2 8.5 6" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" /><circle cx="25" cy="23.5" r="2.5" fill="#fb923c" /></svg>
          <span className="text-lg font-bold tracking-[0.14em]">CREW</span>
          <span className="ml-1 text-xs uppercase tracking-[0.18em] text-white/65">by Sampledge</span>
        </div>
        <div className="relative max-w-lg">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">One intelligent platform.<br />Your entire workforce.</h1>
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-white/70">
            Recruitment, people, attendance, payroll and workforce intelligence on one connected foundation. Let CREW handle the repetitive work, so your people can focus on people.
          </p>
          <ul className="mt-8 grid gap-3 text-sm text-white/80">
            {['Isolated per company at the database level', 'Multi-factor sign-in and a tamper-evident audit trail', 'Permissions that follow your org chart'].map((t) => (
              <li key={t} className="flex items-center gap-2.5"><span className="size-1.5 rounded-full bg-[#fb923c]" />{t}</li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/65">© {new Date().getFullYear()} SAMPLEDGE</p>
      </aside>
      <main className="flex items-center justify-center px-4 py-10 sm:px-10">
        <div className="w-full max-w-sm animate-slide-up">
          <div className="mb-8 lg:hidden"><CrewLogo subtitle="by Sampledge" /></div>
          {children}
        </div>
      </main>
    </div>
  );
}
