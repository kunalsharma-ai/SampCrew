import { accessToken } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const API_URL = process.env.CREW_API_URL ?? 'http://localhost:4000';

/**
 * Live updates for the signed-in member (new notifications, read changes, chat messages and read receipts). The
 * browser never talks to the API directly: this relays the API's event stream with the session's token. The API
 * closes the stream after a while and the browser's EventSource reconnects, which also picks up a refreshed token.
 */
export async function GET(req: Request) {
  const token = await accessToken();
  if (!token) return new Response('Sign in again', { status: 401 });
  const upstream = await fetch(`${API_URL}/api/v1/notifications/stream`, {
    headers: { authorization: `Bearer ${token}`, 'x-crew-client': 'web', accept: 'text/event-stream' },
    cache: 'no-store',
    signal: req.signal,
  }).catch(() => null);
  if (!upstream || !upstream.ok || !upstream.body) return new Response('Live updates are not available', { status: upstream?.status === 401 ? 401 : 503 });
  return new Response(upstream.body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  });
}
