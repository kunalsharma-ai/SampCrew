export interface ModuleRow { key: string; name: string; module: string; core: boolean; inPlan: boolean; enabled: boolean; switchedOffByAdmin: boolean; blockedBy: string | null }
export interface MatrixPermission { key: string; description: string; action: string; scopes: string[]; requiresMfa: boolean; sensitive: boolean; disabledBySampledge: boolean }
export interface MatrixRole { id: string; key: string; name: string; description: string | null; isSystem: boolean; locked: boolean; customised: boolean; canReset: boolean; memberCount: number; grants: Record<string, string> }
export interface Matrix {
  actions: { key: string; label: string }[];
  modules: { module: string; feature: string | null; available: boolean; permissions: MatrixPermission[] }[];
  roles: MatrixRole[];
}
