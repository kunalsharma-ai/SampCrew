import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Container health check. `live` answers as long as this server runs; with `?ready=1` it also checks the API it
 * talks to is ready, so a load balancer only sends traffic once sign-in can work.
 */
export async function GET(req: Request) {
  if (!new URL(req.url).searchParams.has('ready')) return NextResponse.json({ status: 'ok' });
  const api = process.env.CREW_API_URL ?? 'http://localhost:4000';
  try {
    const r = await fetch(`${api}/api/v1/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (r.ok) return NextResponse.json({ status: 'ok', api: 'ok' });
    return NextResponse.json({ status: 'unavailable', api: r.status }, { status: 503 });
  } catch {
    return NextResponse.json({ status: 'unavailable', api: 'unreachable' }, { status: 503 });
  }
}
