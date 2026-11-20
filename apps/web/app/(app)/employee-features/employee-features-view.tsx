'use client';
import { isFeatureAction, type EmployeeFeatureRow, type EmployeeFeatureScope } from '@crew/contracts';
import { Alert, Card, CardBody, CardHeader, FeatureSwitchBoard, Field, Select } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setEmployeeFeaturesAction } from './actions';

const COLUMN = [{ key: 'employee', label: 'Employee Workspace', target: 'Employee Workspace people here' }];

/** HR Workspace > Employee Workspace: one switch per module and page, within what the Super Workspace allows. */
export function EmployeeFeaturesView({ scopes, scope, rows }: { scopes: EmployeeFeatureScope[]; scope: EmployeeFeatureScope; rows: EmployeeFeatureRow[] }) {
  const router = useRouter();
  const [list, setList] = useState(rows);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const change = (key: string, _column: string, enabled: boolean) => start(async () => {
    const name = list.find((r) => r.key === key)?.name ?? key;
    const res = await setEmployeeFeaturesAction(scope.id, [{ key, enabled }]);
    if (res.ok && res.data) setList(res.data.items);
    setFlash({ tone: res.ok ? 'success' : 'danger', text: res.ok ? `${name}: ${res.message}` : res.message });
  });
  return (
    <Card>
      <CardHeader
        title={scope.id === 'central' ? 'Central group' : scope.name}
        description={scope.id === 'central' ? 'Everyone with Employee Workspace access who is not in an HR Workspace.' : `Everyone with Employee Workspace access in ${scope.name}.`}
        action={scopes.length > 1 ? (
          <Field label="Group">
            {(p) => (
              <Select {...p} value={scope.id} data-testid="feature-scope" onChange={(e) => router.push(`/employee-features?scope=${e.target.value}`)}>
                {scopes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
          </Field>
        ) : undefined}
      />
      <CardBody>
        <FeatureSwitchBoard
          rows={list.map((r) => ({ key: r.key, name: r.name, module: r.module, parent: r.parent, kind: isFeatureAction(r.key) ? 'action' as const : 'page' as const, audience: r.audience, cells: { employee: r.cell } }))}
          columns={COLUMN}
          busy={pending}
          onChange={change}
          intro={flash ? <Alert tone={flash.tone}>{flash.text}</Alert> : <p className="text-xs text-fg-subtle">Inherited: on, as the Super Workspace allows. Inactive: you switched it off. Restricted: switched off above you, by SAMPLEDGE, the plan or the Super Workspace. HR Workspace people keep their own access.</p>}
        />
      </CardBody>
    </Card>
  );
}
