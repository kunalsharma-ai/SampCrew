'use client';
import { Alert, Button } from '@crew/ui';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/** Shows a secret that the server returns only once, with a copy button. */
export function SecretOnce({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Alert tone="warning" title={`Copy the ${label} now`}>
      <p>SampCrew stores only a hash or an encrypted copy and will not show it again. If you lose it, create a new one.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code data-testid="secret-value" className="break-all rounded bg-surface px-2 py-1 font-mono text-[0.75rem] text-fg">{value}</code>
        <Button size="sm" variant="secondary" type="button" onClick={() => { void navigator.clipboard?.writeText(value).catch(() => undefined); setCopied(true); }}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onDone}>I have stored it</Button>
      </div>
    </Alert>
  );
}
