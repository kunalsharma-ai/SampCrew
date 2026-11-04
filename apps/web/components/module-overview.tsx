import type { ModuleOverview as Overview, OverviewModule } from '@crew/contracts';
import { cn } from '@crew/ui';
import { loadOptional } from '@/lib/api';
import { type BarAction, KpiRow, OverviewChartView, QuickBar } from './neon';

/**
 * The neon overview at the top of a module page: KPI tiles, charts and a quick action bar, all from
 * GET /dashboard/modules/:module. People whose access covers only their own record get nothing here (the API
 * answers 403), so self-service pages look exactly as before.
 */
export async function ModuleOverview({ module, actions = [] }: { module: OverviewModule; actions?: BarAction[] }) {
  const data = await loadOptional<Overview>(`/dashboard/modules/${module}`);
  if (!data) return actions.length ? <div className="mb-6"><QuickBar actions={actions} /></div> : null;
  const n = data.charts.length;
  return (
    <section aria-label={`${module[0]!.toUpperCase()}${module.slice(1)} overview`} className="mb-6 grid gap-4 animate-fade-in" data-testid={`overview-${module}`}>
      <KpiRow tiles={data.tiles} />
      {n > 0 && (
        <div className={cn('grid gap-4', n >= 3 ? 'lg:grid-cols-2 xl:grid-cols-3' : 'lg:grid-cols-2')}>
          {data.charts.map((c) => <OverviewChartView key={c.key} chart={c} />)}
        </div>
      )}
      <QuickBar actions={actions} />
    </section>
  );
}

export interface GatedAction extends BarAction { permission?: string; feature?: string }

/** Keeps the actions the member can actually use, so the bar never links to a page that would refuse them. */
export function allowed(me: { permissions: Record<string, string>; features: string[] }, actions: GatedAction[]): BarAction[] {
  return actions
    .filter((a) => (!a.permission || me.permissions[a.permission]) && (!a.feature || me.features.includes(a.feature)))
    .map(({ label, href, icon }) => ({ label, href, icon }));
}
