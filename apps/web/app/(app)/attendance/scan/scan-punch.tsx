'use client';
import { Alert, Button, Card, CardBody } from '@crew/ui';
import { QrCode } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { qrPunchAction } from '../actions';

export function ScanPunch({ code }: { code: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  if (!code) return <Alert tone="danger">This link has no code. Scan the QR code on the kiosk screen again.</Alert>;
  return (
    <Card className="max-w-md">
      <CardBody className="grid gap-4 pt-5">
        {result && <Alert tone={result.ok ? 'success' : 'danger'}>{result.text}</Alert>}
        {!result?.ok && (
          <Button size="lg" loading={pending} onClick={() => start(async () => {
            const r = await qrPunchAction(code);
            if (r.ok) {
              const p = r.data!.punch;
              setResult({ ok: true, text: r.data!.duplicate ? 'Already recorded: this code was used for your punch a moment ago.' : `Punched ${p.direction} at ${new Date(p.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` });
            } else setResult({ ok: false, text: r.message });
          })}>
            <QrCode className="size-4" /> Record my punch
          </Button>
        )}
        <Link className="text-sm text-accent hover:underline" href="/attendance">Go to my attendance</Link>
      </CardBody>
    </Card>
  );
}
