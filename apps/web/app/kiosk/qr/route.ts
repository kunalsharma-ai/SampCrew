import { type NextRequest, NextResponse } from 'next/server';
import QRCode from 'qrcode';

const API_URL = process.env.CREW_API_URL ?? 'http://localhost:4000';

/**
 * Kiosk screens are not signed in: they hold a kiosk token instead. The screen posts the token here (it stays in
 * the URL fragment, so it never reaches server logs), and this handler asks the API for the current code and
 * renders the QR that phones scan.
 */
export async function POST(req: NextRequest) {
  const { token } = (await req.json().catch(() => ({}))) as { token?: unknown };
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return NextResponse.json({ message: 'This kiosk link is incomplete.' }, { status: 400 });
  const res = await fetch(`${API_URL}/api/v1/kiosk/qr`, { headers: { 'x-kiosk-token': token }, cache: 'no-store' }).catch(() => null);
  if (!res) return NextResponse.json({ message: 'Cannot reach CREW. Retrying.' }, { status: 503 });
  const data = (await res.json().catch(() => ({}))) as { code?: string; error?: { message?: string }; kiosk?: string; location?: string; workspace?: string; expiresAt?: string; refreshSeconds?: number };
  if (!res.ok || !data.code) return NextResponse.json({ message: data.error?.message ?? 'This kiosk link is not valid.' }, { status: res.status === 401 ? 401 : 502 });
  const origin = process.env.WEB_PUBLIC_URL ?? req.nextUrl.origin;
  const url = `${origin.replace(/\/$/, '')}/attendance/scan?c=${encodeURIComponent(data.code)}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return NextResponse.json(
    { kiosk: data.kiosk, location: data.location, workspace: data.workspace, expiresAt: data.expiresAt, refreshSeconds: data.refreshSeconds, svg },
    { headers: { 'cache-control': 'no-store' } },
  );
}
