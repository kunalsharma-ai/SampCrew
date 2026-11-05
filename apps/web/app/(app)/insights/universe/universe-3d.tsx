'use client';
import type { PlacedPerson } from '@crew/contracts';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export interface SceneDepartment { id: string; name: string; parentId: string | null; color: string; count: number }
export interface Universe3DProps {
  departments: SceneDepartment[];
  people: PlacedPerson[];
  links: { a: string; b: string; count: number }[];
  showReporting: boolean;
  /** People who joined or moved in the step being shown; they glow briefly. */
  fresh: Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  reducedMotion: boolean;
  onUnsupported: () => void;
}

interface Node { mesh: THREE.Mesh; target: THREE.Vector3; scale: number; leaving: boolean; glow: number }
interface World {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  deptGroup: THREE.Group;
  peopleGroup: THREE.Group;
  deptMeshes: Map<string, { mesh: THREE.Mesh; label: CSS2DObject; target: number }>;
  centers: Map<string, THREE.Vector3>;
  nodes: Map<string, Node>;
  personGeo: THREE.SphereGeometry;
  deptGeo: THREE.SphereGeometry;
  links: THREE.LineSegments;
  hierarchy: THREE.LineSegments;
  reporting: THREE.LineSegments;
  managers: Map<string, string | null>;
  frame: number;
  props: Universe3DProps;
}

const NONE = 'none';

/** Roots on a ring, each department's children on a smaller ring one level below. Stable across dates. */
function layout(departments: SceneDepartment[]): Map<string, THREE.Vector3> {
  const ids = new Set(departments.map((d) => d.id));
  const children = new Map<string | null, SceneDepartment[]>();
  for (const d of departments) {
    const parent = d.parentId && ids.has(d.parentId) ? d.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), d]);
  }
  const out = new Map<string, THREE.Vector3>();
  const roots = children.get(null) ?? [];
  const R = Math.max(5, roots.length * 1.5);
  roots.forEach((d, i) => {
    const a = (i / Math.max(1, roots.length)) * Math.PI * 2;
    out.set(d.id, new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R));
  });
  const place = (parent: string, depth: number) => {
    const kids = children.get(parent) ?? [];
    const c = out.get(parent)!;
    kids.forEach((d, i) => {
      const a = (i / Math.max(1, kids.length)) * Math.PI * 2 + depth;
      const r = 3.2 / depth;
      out.set(d.id, new THREE.Vector3(c.x + Math.cos(a) * r, c.y - 3, c.z + Math.sin(a) * r));
      place(d.id, depth + 1);
    });
  };
  for (const d of roots) place(d.id, 1);
  out.set(NONE, new THREE.Vector3(0, 2.5, 0));
  return out;
}

const coreRadius = (n: number) => 0.35 + 0.09 * Math.sqrt(n);

/** People sit on a shell around their department, spread evenly (Fibonacci sphere). */
function shellPoint(center: THREE.Vector3, i: number, n: number): THREE.Vector3 {
  const r = coreRadius(n) + 0.55 + 0.12 * Math.cbrt(n);
  const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
  const rad = Math.sqrt(1 - y * y);
  const theta = i * Math.PI * (3 - Math.sqrt(5));
  return new THREE.Vector3(center.x + Math.cos(theta) * rad * r, center.y + y * r, center.z + Math.sin(theta) * rad * r);
}

/**
 * The 3D organization map: departments as glowing cores sized by headcount, people orbiting them, lines for
 * reporting that crosses departments, and people gliding between departments as the date changes. Loaded
 * only on this page; the 2D table next to it is the accessible equivalent.
 */
export default function Universe3D(props: Universe3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const world = useRef<World | null>(null);

  // One-time scene set-up.
  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      props.onUnsupported();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    el.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.setSize(el.clientWidth, el.clientHeight);
    labels.domElement.style.position = 'absolute';
    labels.domElement.style.inset = '0';
    labels.domElement.style.pointerEvents = 'none';
    el.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0b1020, 0.012);
    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.1, 500);
    camera.position.set(0, 9, 18);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = !props.reducedMotion;
    controls.autoRotateSpeed = 0.35;
    controls.maxDistance = 120;
    controls.minDistance = 3;
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.PointLight(0xffffff, 120, 0, 2);
    key.position.set(6, 14, 10);
    scene.add(key);

    // A faint star field gives depth without carrying data.
    const stars = new THREE.BufferGeometry();
    const pts: number[] = [];
    for (let i = 0; i < 600; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(60 + Math.random() * 60);
      pts.push(v.x, v.y, v.z);
    }
    stars.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.Points(stars, new THREE.PointsMaterial({ color: 0x8b93b8, size: 0.25, transparent: true, opacity: 0.6 })));

    const mkLines = (color: number, opacity: number) => {
      const l = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
      scene.add(l);
      return l;
    };
    const w: World = {
      renderer, labels, scene, camera, controls,
      deptGroup: new THREE.Group(), peopleGroup: new THREE.Group(),
      deptMeshes: new Map(), centers: new Map(), nodes: new Map(),
      personGeo: new THREE.SphereGeometry(0.11, 12, 12), deptGeo: new THREE.SphereGeometry(1, 32, 32),
      links: mkLines(0xf59e0b, 0.7), hierarchy: mkLines(0x64748b, 0.35), reporting: mkLines(0x93c5fd, 0.25),
      managers: new Map(), frame: 0, props,
    };
    scene.add(w.deptGroup, w.peopleGroup);
    world.current = w;

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    const pick = (ev: PointerEvent, objects: THREE.Object3D[]) => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      return ray.intersectObjects(objects, false)[0]?.object;
    };
    const onDown = (ev: PointerEvent) => { down = { x: ev.clientX, y: ev.clientY }; };
    const onUp = (ev: PointerEvent) => {
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return;
      const hit = pick(ev, [...w.deptGroup.children]);
      w.props.onSelect(hit ? (hit.userData.id as string) : null);
    };
    const onMove = (ev: PointerEvent) => {
      const hit = pick(ev, [...w.peopleGroup.children]);
      const t = tip.current!;
      if (hit && !hit.userData.leaving) {
        const r = el.getBoundingClientRect();
        t.textContent = `${hit.userData.name}${hit.userData.designation ? `, ${hit.userData.designation}` : ''}`;
        t.style.transform = `translate(${ev.clientX - r.left + 12}px, ${ev.clientY - r.top + 12}px)`;
        t.style.opacity = '1';
        renderer.domElement.style.cursor = 'pointer';
      } else {
        t.style.opacity = '0';
        renderer.domElement.style.cursor = pick(ev, [...w.deptGroup.children]) ? 'pointer' : 'grab';
      }
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointermove', onMove);
    const resize = new ResizeObserver(() => {
      camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
      labels.setSize(el.clientWidth, el.clientHeight);
    });
    resize.observe(el);

    const tick = () => {
      w.frame = requestAnimationFrame(tick);
      const k = w.props.reducedMotion ? 1 : 0.08;
      for (const [id, n] of w.nodes) {
        n.mesh.position.lerp(n.target, k);
        const s = n.mesh.scale.x + (n.scale - n.mesh.scale.x) * (w.props.reducedMotion ? 1 : 0.12);
        n.mesh.scale.setScalar(s);
        const m = n.mesh.material as THREE.MeshStandardMaterial;
        if (n.glow > 0) { n.glow = Math.max(0, n.glow - 0.01); m.emissiveIntensity = 0.35 + n.glow * 2; }
        if (n.leaving && s < 0.02) {
          w.peopleGroup.remove(n.mesh);
          m.dispose();
          w.nodes.delete(id);
        }
      }
      for (const d of w.deptMeshes.values()) {
        const s = d.mesh.scale.x + (d.target - d.mesh.scale.x) * (w.props.reducedMotion ? 1 : 0.1);
        d.mesh.scale.setScalar(s);
      }
      if (w.props.showReporting) {
        const seg: number[] = [];
        for (const [id, mgr] of w.managers) {
          const a = w.nodes.get(id);
          const b = mgr ? w.nodes.get(mgr) : undefined;
          if (a && b && !a.leaving && !b.leaving) seg.push(a.mesh.position.x, a.mesh.position.y, a.mesh.position.z, b.mesh.position.x, b.mesh.position.y, b.mesh.position.z);
        }
        w.reporting.geometry.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
      }
      w.reporting.visible = w.props.showReporting;
      controls.update();
      renderer.render(scene, camera);
      labels.render(scene, camera);
    };
    tick();
    el.dataset.ready = 'true';

    return () => {
      cancelAnimationFrame(w.frame);
      resize.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointermove', onMove);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
      });
      renderer.dispose();
      el.replaceChildren();
      world.current = null;
    };
    // The scene is built once; later prop changes are applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply the data for the date being shown.
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    w.props = props;
    w.controls.autoRotate = !props.reducedMotion && !props.selected;
    const centers = layout(props.departments);
    w.centers = centers;

    // Department cores and labels.
    const seen = new Set<string>();
    const all = [...props.departments, ...(props.people.some((p) => !p.departmentId) ? [{ id: NONE, name: 'No department', parentId: null, color: '#94a3b8', count: props.people.filter((p) => !p.departmentId).length }] : [])];
    for (const d of all) {
      seen.add(d.id);
      let entry = w.deptMeshes.get(d.id);
      if (!entry) {
        const mesh = new THREE.Mesh(w.deptGeo, new THREE.MeshStandardMaterial({ color: d.color, emissive: d.color, emissiveIntensity: 0.6, transparent: true, opacity: 0.9, roughness: 0.35 }));
        mesh.userData.id = d.id;
        mesh.scale.setScalar(0.01);
        const div = document.createElement('div');
        div.style.cssText = 'padding:2px 8px;border-radius:999px;background:rgba(15,23,42,.72);color:#f8fafc;font:500 11px/1.4 ui-sans-serif,system-ui;white-space:nowrap;border:1px solid rgba(255,255,255,.12)';
        const label = new CSS2DObject(div);
        label.center.set(0.5, -0.6);
        mesh.add(label);
        w.deptGroup.add(mesh);
        entry = { mesh, label, target: 0.3 };
        w.deptMeshes.set(d.id, entry);
      }
      entry.mesh.position.copy(centers.get(d.id) ?? new THREE.Vector3());
      entry.target = d.count ? coreRadius(d.count) : 0.18;
      const mat = entry.mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = d.count ? 0.92 : 0.25;
      mat.emissiveIntensity = props.selected === d.id ? 1.4 : props.selected ? 0.25 : 0.6;
      const div = entry.label.element as HTMLDivElement;
      div.textContent = `${d.name} · ${d.count}`;
      div.dataset.selected = String(props.selected === d.id);
      div.style.borderColor = props.selected === d.id ? d.color : 'rgba(255,255,255,.12)';
      div.style.opacity = d.count || props.selected === d.id ? '1' : '0.45';
    }
    for (const [id, entry] of w.deptMeshes) {
      if (seen.has(id)) continue;
      entry.label.element.remove();
      w.deptGroup.remove(entry.mesh);
      (entry.mesh.material as THREE.Material).dispose();
      w.deptMeshes.delete(id);
    }

    // Department hierarchy and cross-department reporting.
    const hier: number[] = [];
    for (const d of props.departments) {
      const a = centers.get(d.id);
      const b = d.parentId ? centers.get(d.parentId) : undefined;
      if (a && b) hier.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    w.hierarchy.geometry.setAttribute('position', new THREE.Float32BufferAttribute(hier, 3));
    const link: number[] = [];
    for (const l of props.links) {
      const a = centers.get(l.a);
      const b = centers.get(l.b);
      if (!a || !b) continue;
      // Thicker relationships are drawn as several slightly offset lines (WebGL lines are one pixel wide).
      for (let i = 0; i < Math.min(4, l.count); i++) link.push(a.x, a.y + i * 0.06, a.z, b.x, b.y + i * 0.06, b.z);
    }
    w.links.geometry.setAttribute('position', new THREE.Float32BufferAttribute(link, 3));

    // People.
    const groups = new Map<string, PlacedPerson[]>();
    for (const p of props.people) {
      const k = p.departmentId && centers.has(p.departmentId) ? p.departmentId : NONE;
      groups.set(k, [...(groups.get(k) ?? []), p]);
    }
    const present = new Set<string>();
    w.managers = new Map(props.people.map((p) => [p.id, p.managerId]));
    for (const [deptId, list] of groups) {
      const color = all.find((d) => d.id === deptId)?.color ?? '#94a3b8';
      const c = centers.get(deptId) ?? new THREE.Vector3();
      list.sort((a, b) => a.joined.localeCompare(b.joined) || a.id.localeCompare(b.id));
      list.forEach((p, i) => {
        present.add(p.id);
        const target = shellPoint(c, i, list.length);
        let n = w.nodes.get(p.id);
        if (!n) {
          const mesh = new THREE.Mesh(w.personGeo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.4 }));
          mesh.position.copy(c);
          mesh.scale.setScalar(0.01);
          w.peopleGroup.add(mesh);
          n = { mesh, target, scale: 1, leaving: false, glow: 0 };
          w.nodes.set(p.id, n);
        }
        n.target = target;
        n.leaving = false;
        n.scale = p.hasLogin ? 1 : 0.8;
        n.mesh.userData = { id: p.id, name: p.name, designation: p.designation, leaving: false };
        const m = n.mesh.material as THREE.MeshStandardMaterial;
        m.color.set(color);
        m.emissive.set(color);
        if (props.fresh.has(p.id)) n.glow = 1;
      });
    }
    for (const [id, n] of w.nodes) {
      if (present.has(id)) continue;
      n.leaving = true;
      n.scale = 0;
      n.mesh.userData.leaving = true;
    }
  }, [props]);

  // Frame the whole organization once, then focus the selected department when there is one.
  const framed = useRef(false);
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    const box = new THREE.Box3();
    for (const [id, v] of w.centers) if (id !== NONE || w.deptMeshes.has(NONE)) box.expandByPoint(v);
    const mid = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const c = props.selected ? w.centers.get(props.selected) : null;
    w.controls.target.copy(c ?? mid);
    if (!framed.current && !box.isEmpty()) {
      framed.current = true;
      const size = box.getSize(new THREE.Vector3()).length() + 6;
      const dist = size / (2 * Math.tan((w.camera.fov * Math.PI) / 360)) * 0.9;
      w.camera.position.set(mid.x, mid.y + dist * 0.45, mid.z + dist);
    }
  }, [props.selected, props.departments]);

  return (
    <div className="relative h-full w-full overflow-hidden" data-testid="universe-3d">
      <div ref={host} className="absolute inset-0" />
      <div ref={tip} className="pointer-events-none absolute left-0 top-0 rounded-md bg-black/75 px-2 py-1 text-xs text-white opacity-0 transition-opacity" />
    </div>
  );
}
