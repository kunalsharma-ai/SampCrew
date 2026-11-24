'use client';
import { DeletePasswordProvider as Provider } from '@crew/ui';
import { confirmDeleteAction } from '@/app/(app)/delete-actions';

export { DeletePasswordContext, useDeleteRetry } from '@crew/ui';

/** The shared password dialog for deletes (@crew/ui delete-password.tsx), checking the password with the Web Portal's server action. */
export function DeletePasswordProvider({ children }: { children: React.ReactNode }) {
  return <Provider confirm={confirmDeleteAction}>{children}</Provider>;
}
