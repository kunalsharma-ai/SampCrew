'use client';
import { Button, EmptyState } from '@crew/ui';
import { TriangleAlert } from 'lucide-react';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="py-16">
      <EmptyState
        icon={<TriangleAlert className="size-6" />}
        title="Something went wrong loading this page"
        description={<>Try again in a moment. If it keeps happening, share this reference with support: <code className="font-mono text-xs">{error.digest ?? 'n/a'}</code></>}
        action={<Button onClick={reset}>Try again</Button>}
      />
    </div>
  );
}
