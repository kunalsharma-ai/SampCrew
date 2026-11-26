import { NextResponse } from 'next/server';

/**
 * Map tiles for the office location picker, fetched by the server so the page keeps its strict image policy (images
 * from this site only) and the person's browser never talks to the map provider. Tiles are cached for a week.
 * The provider is OpenStreetMap's standard tile server; its usage policy asks for a real User-Agent and caching.
 */
const TILE_HOST = 'https://tile.openstreetmap.org';

export async function GET(_req: Request, { params }: { params: Promise<{ z: string; x: string; y: string }> }) {
  const { z, x, y } = await params;
  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(String(y).replace(/\.png$/, ''));
  const max = 2 ** zi;
  if (![zi, xi, yi].every(Number.isInteger) || zi < 0 || zi > 19 || xi < 0 || yi < 0 || xi >= max || yi >= max) {
    return new NextResponse('Bad tile', { status: 400 });
  }
  try {
    const res = await fetch(`${TILE_HOST}/${zi}/${xi}/${yi}.png`, {
      headers: { 'user-agent': 'SampCrew-attendance-map/1.0', accept: 'image/png' },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 604_800 },
    });
    if (!res.ok || !res.body) return new NextResponse('Tile not available', { status: 502 });
    return new NextResponse(res.body, {
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800, immutable', 'x-content-type-options': 'nosniff' },
    });
  } catch {
    return new NextResponse('Tile not available', { status: 502 });
  }
}
