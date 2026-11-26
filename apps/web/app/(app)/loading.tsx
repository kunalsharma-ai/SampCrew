import { Skeleton } from '@crew/ui';

/**
 * Shown the moment a page is opened, inside the menu and top bar that stay in place, while its data loads (issue #89
 * point 16): a click answers at once instead of waiting on the server with the old page still showing.
 */
export default function Loading() {
  return (
    <div className="grid gap-5" aria-busy="true" aria-live="polite" data-testid="page-loading">
      <span className="sr-only">Loading…</span>
      <div className="grid gap-2">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
