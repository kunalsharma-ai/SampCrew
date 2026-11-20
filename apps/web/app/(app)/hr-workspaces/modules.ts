import { BOOLEAN_FEATURES, type DelegatedModule, isCoreFeature } from '@crew/contracts';

/** The same states the API reports, for a new HR Workspace that has nothing given yet. */
export function moduleStates(given: string[], companyFeatures: string[], nonDelegable: string[]): DelegatedModule[] {
  return BOOLEAN_FEATURES.map((f) => {
    const core = isCoreFeature(f.key);
    const held = companyFeatures.includes(f.key);
    const allowed = core || (held && !nonDelegable.includes(f.key));
    return {
      key: f.key, name: f.name, module: f.module, core,
      state: !allowed ? 'locked' : core || given.includes(f.key) ? 'granted' : 'available',
      lockedBy: allowed ? null : 'console',
    };
  });
}

export const MODULE_NAME: Record<string, string> = Object.fromEntries(BOOLEAN_FEATURES.map((f) => [f.key, f.name]));
