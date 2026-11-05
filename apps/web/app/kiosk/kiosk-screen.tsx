'use client';
import { useEffect, useState } from 'react';

type Display = { kiosk: string; location: string; workspace: string; expiresAt: string; refreshSeconds: number; svg: string };

/** Full-screen kiosk display. The kiosk token lives in the URL fragment (#...) so it is never sent in a request line. */
export function KioskScreen() {
  const [data, setData] = useState<Display | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const token = window.location.hash.slice(1);
    if (!token) {
      setError('This screen needs a kiosk link. Create one under Settings, Attendance, QR kiosks.');
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const load = async () => {
      let wait = 5000;
      try {
        const res = await fetch('/kiosk/qr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), cache: 'no-store' });
        const body = await res.json();
        if (res.ok) {
          setData(body as Display);
          setError(null);
          // Fetch again just after the code rotates.
          wait = Math.max(1000, Date.parse(body.expiresAt) - Date.now() + 300);
        } else {
          setError(body.message ?? 'Something went wrong.');
          if (res.status === 401) {
            setData(null);
            return; // revoked or invalid: do not keep retrying
          }
        }
      } catch {
        setError('Connection lost. Retrying.');
      }
      if (!stopped) timer = setTimeout(load, wait);
    };
    void load();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, []);

  const left = data ? Math.max(0, Math.ceil((Date.parse(data.expiresAt) - now) / 1000)) : 0;
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-bg p-6 text-center">
      {data ? (
        <>
          <div>
            <p className="text-sm text-fg-muted">{data.workspace}</p>
            <h1 className="text-2xl font-semibold">{data.location}</h1>
            <p className="text-sm text-fg-muted">{data.kiosk}</p>
          </div>
          <div className="w-full max-w-sm rounded-xl bg-white p-4 shadow-sm" aria-label="QR code to punch in or out" dangerouslySetInnerHTML={{ __html: data.svg }} />
          <p className="text-lg">Scan with your phone camera to punch in or out.</p>
          <p className="text-sm text-fg-muted">You need to be signed in to CREW on your phone. New code in {left}s.</p>
        </>
      ) : (
        <h1 className="text-xl font-semibold">Attendance kiosk</h1>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </main>
  );
}
