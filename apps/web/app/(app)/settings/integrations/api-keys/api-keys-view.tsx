'use client';
import { Alert, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useRunner } from '../../../recruitment/use-runner';
import { createApiKeyAction, revokeApiKeyAction } from '../actions';
import { when } from '../labels';
import { SecretOnce } from '../secret-once';
import type { ApiKey } from '../types';

const EXPIRY = [{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '180', label: '180 days' }, { value: '365', label: '1 year' }, { value: 'never', label: 'No expiry' }];

export function ApiKeysView({ keys, scopes }: { keys: ApiKey[]; scopes: { key: string; description: string }[] }) {
  const { pending, notice, run } = useRunner();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length >= 3 && chosen.length > 0;

  const submit = () =>
    run(async () => {
      const r = await createApiKeyAction({ name: name.trim(), scopes: chosen, expiresInDays: expiry === 'never' ? null : Number(expiry) });
      if (r.ok) {
        setCreated(r.data!.key);
        setOpen(false);
        setName('');
        setChosen([]);
        setError(null);
      } else setError(r.message);
      return r;
    });

  return (
    <div className="grid gap-6">
      {notice && !created && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {created && <SecretOnce label="API key" value={created} onDone={() => setCreated(null)} />}
      <Alert tone="info" title="How to call the API">
        Send the key as <code className="font-mono">Authorization: Bearer crew_…</code>. Keys can only read, and only from routes covered by their scopes; anything else is refused. The API reference is in the OpenAPI file shipped with SampCrew.
      </Alert>
      <Card>
        <CardHeader title="Keys" action={<Button size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> Create key</Button>} />
        {keys.length ? (
          <Table>
            <THead><tr><TH>Name</TH><TH>Scopes</TH><TH>Status</TH><TH>Last used</TH><TH>Expires</TH><TH /></tr></THead>
            <TBody>
              {keys.map((k) => (
                <TR key={k.id}>
                  <TD>
                    <div className="font-medium">{k.name}</div>
                    <div className="text-xs text-fg-muted"><span className="font-mono">crew_{k.prefix}_…</span> · by {k.createdBy}</div>
                  </TD>
                  <TD className="max-w-[16rem] text-xs text-fg-muted">{k.scopes.join(', ')}</TD>
                  <TD><StatusPill status={k.status} /></TD>
                  <TD className="text-fg-muted">{when(k.lastUsedAt)}{k.useCount ? <div className="text-xs">{k.useCount} calls{k.lastUsedIp ? ` · ${k.lastUsedIp}` : ''}</div> : null}</TD>
                  <TD className="text-fg-muted">{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'Never'}</TD>
                  <TD className="text-right">
                    {!k.revokedAt && (
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => { if (confirm(`Revoke "${k.name}"? Systems using it stop working at once.`)) run(() => revokeApiKeyAction(k.id)); }}>Revoke</Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No API keys yet" description="Create a key for each system that needs to read SampCrew data, with only the scopes it needs." />}
      </Card>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Create API key"
        description="The full key is shown once, right after you create it."
        size="lg"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!valid} onClick={submit}>Create key</Button></>}
      >
        <div className="grid gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Name" hint="Which system uses it, e.g. Payroll bureau export" required>
            {(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Expires after">
            {(p) => <Select {...p} value={expiry} onChange={(e) => setExpiry(e.target.value)}>{EXPIRY.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>}
          </Field>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-[0.8125rem] font-medium">Scopes (read only)</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {scopes.map((s) => (
                <Checkbox key={s.key} label={s.key} description={s.description} checked={chosen.includes(s.key)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.key] : chosen.filter((x) => x !== s.key))} />
              ))}
            </div>
          </fieldset>
        </div>
      </Dialog>
    </div>
  );
}
