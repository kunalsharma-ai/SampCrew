/** Why the Web Portal ended a session itself, shown on the sign-in page (`/login?reason=`). */
export const SIGNED_OUT_REASONS: Record<string, string> = {
  expired: 'Your session ended. Sign in again.',
  tenant_suspended: 'This workspace is suspended, so you were signed out. Contact your administrator or SAMPLEDGE support.',
  app_switched_off: 'SAMPLEDGE has switched the Web Portal off for this workspace, so you were signed out. Use the SampCrew mobile app, or ask your workspace owner to contact SAMPLEDGE support.',
  blocked: 'You were signed out because this workspace cannot be opened in the Web Portal right now. Contact your administrator.',
};
