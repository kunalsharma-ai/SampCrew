'use client';
import { cn } from '@crew/ui';
import { Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A small interactive map: drag to move, scroll or the buttons to zoom, click to place the office. Geofences are drawn
 * to scale. Tiles come through this site (/map-tiles), so the page needs no outside images; when they cannot load, a
 * grid stays and clicking still sets the point.
 */
export interface MapCircle { lat: number; lon: number; radiusM: number; tone?: 'accent' | 'success' | 'ember' | 'muted'; label?: string }

const TILE = 256;
const project = (lat: number, lon: number, z: number) => {
  const s = TILE * 2 ** z;
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * s, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s };
};
const unproject = (x: number, y: number, z: number) => {
  const s = TILE * 2 ** z;
  const lon = (x / s) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / s;
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon };
};
const metresPerPixel = (lat: number, z: number) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

const STROKE = { accent: 'stroke-accent fill-accent/15', success: 'stroke-success fill-success/15', ember: 'stroke-ember fill-ember/15', muted: 'stroke-fg-subtle fill-fg-subtle/10' };

export function GeoMap({ center, circles = [], onPick, height = 320, zoom: initialZoom = 16, className }: { center: { lat: number; lon: number }; circles?: MapCircle[]; onPick?: (lat: number, lon: number) => void; height?: number; zoom?: number; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [zoom, setZoom] = useState(initialZoom);
  const [view, setView] = useState(center);
  const [failed, setFailed] = useState(0);
  const drag = useRef<{ x: number; y: number; moved: boolean; start: { lat: number; lon: number } } | null>(null);

  useEffect(() => setView(center), [center.lat, center.lon]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const c = project(view.lat, view.lon, zoom);
  const left = c.x - width / 2;
  const top = c.y - height / 2;
  const tiles: { x: number; y: number; key: string }[] = [];
  const n = 2 ** zoom;
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width) / TILE); tx++) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      tiles.push({ x: tx, y: ty, key: `${zoom}/${tx}/${ty}` });
    }
  }
  const toPoint = (lat: number, lon: number) => {
    const p = project(lat, lon, zoom);
    return { x: p.x - left, y: p.y - top };
  };
  const zoomBy = useCallback((d: number) => setZoom((z) => Math.max(3, Math.min(19, z + d))), []);

  return (
    <div className={cn('relative select-none overflow-hidden rounded-xl border border-border bg-bg-subtle', className)} style={{ height }} data-testid="geo-map">
      <div
        ref={box}
        className={cn('absolute inset-0 touch-none', onPick ? 'cursor-crosshair' : 'cursor-grab')}
        style={{ backgroundImage: 'linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)', backgroundSize: '32px 32px', backgroundPosition: `${-left % 32}px ${-top % 32}px` }}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, moved: false, start: view }; }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
          if (!d.moved) return;
          const s = project(d.start.lat, d.start.lon, zoom);
          setView(unproject(s.x - dx, s.y - dy, zoom));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d || d.moved || !onPick || !box.current) return;
          const r = box.current.getBoundingClientRect();
          const p = unproject(left + (e.clientX - r.left), top + (e.clientY - r.top), zoom);
          onPick(Number(p.lat.toFixed(6)), Number(p.lon.toFixed(6)));
        }}
        onWheel={(e) => { if (e.ctrlKey || Math.abs(e.deltaY) > 20) zoomBy(e.deltaY > 0 ? -1 : 1); }}
        role="application"
        aria-label={onPick ? 'Map: click to place the office, drag to move' : 'Map of office locations'}
      >
        {tiles.map((t) => {
          const wx = ((t.x % n) + n) % n;
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={t.key} alt="" draggable={false} src={`/map-tiles/${zoom}/${wx}/${t.y}`} width={TILE} height={TILE}
              className="pointer-events-none absolute max-w-none" style={{ left: t.x * TILE - left, top: t.y * TILE - top }}
              onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; setFailed((f) => f + 1); }} />
          );
        })}
        <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
          {circles.map((ci, i) => {
            const p = toPoint(ci.lat, ci.lon);
            const r = ci.radiusM / metresPerPixel(ci.lat, zoom);
            return (
              <g key={i}>
                <circle cx={p.x} cy={p.y} r={Math.max(4, r)} strokeWidth={2} className={STROKE[ci.tone ?? 'accent']} stroke="currentColor" fill="currentColor" style={{ fillOpacity: 0.14 }} />
                <circle cx={p.x} cy={p.y} r={4} className={STROKE[ci.tone ?? 'accent']} stroke="white" strokeWidth={2} fill="currentColor" />
                {ci.label && <text x={p.x} y={p.y - Math.max(10, r) - 6} textAnchor="middle" className="fill-fg text-[11px] font-semibold" style={{ paintOrder: 'stroke', stroke: 'var(--color-surface)', strokeWidth: 3 }}>{ci.label}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="absolute right-2 top-2 grid overflow-hidden rounded-md border border-border bg-surface shadow-sm">
        <button type="button" className="grid size-8 place-items-center hover:bg-bg-subtle" aria-label="Zoom in" onClick={() => zoomBy(1)}><Plus className="size-4" /></button>
        <button type="button" className="grid size-8 place-items-center border-t border-border hover:bg-bg-subtle" aria-label="Zoom out" onClick={() => zoomBy(-1)}><Minus className="size-4" /></button>
      </div>
      <div className="pointer-events-none absolute bottom-1 right-2 rounded bg-surface/80 px-1.5 text-[10px] text-fg-subtle">
        {failed > 0 && tiles.length && failed >= tiles.length ? 'Map tiles unavailable; clicking still sets the point · ' : ''}© OpenStreetMap contributors
      </div>
    </div>
  );
}
