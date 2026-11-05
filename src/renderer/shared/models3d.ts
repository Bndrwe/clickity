// Procedural three.js models for [MODEL3D:kind|label]. No assets: every kind is built from
// primitives. Each builder returns a group roughly 2 units across, centred on the origin, plus an
// optional per-frame `update` (orbiting electrons, planets). Disposal walks the group.
import * as THREE from 'three';
import type { Model3DKind } from '../../shared/visuals';

export interface Palette {
  /** solid neutral for plain shapes (dark ink in the light theme, pale in the dark theme) */
  solid: number;
  /** edge / outline colour */
  edge: number;
  dark: boolean;
}

export interface Built {
  group: THREE.Group;
  /** seconds since the model appeared */
  update?: (t: number) => void;
  /** how far the camera should sit to frame it (default 4.6) */
  distance?: number;
}

const std = (color: number, o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05, ...o });

function sphere(r: number, color: number, o?: THREE.MeshStandardMaterialParameters): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, 40, 28), std(color, o));
}

/** A bond / rod between two points. */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, color: number): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, dir.length(), 16), std(color, { roughness: 0.6 }));
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

function outline(geo: THREE.BufferGeometry, color: number, opacity = 0.55): THREE.LineSegments {
  return new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

function solid(geo: THREE.BufferGeometry, p: Palette): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, std(p.solid, { roughness: 0.42, flatShading: false })));
  g.add(outline(geo, p.edge));
  return g;
}

function ring(radius: number, color: number, opacity = 0.35): THREE.Line {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

function labelSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  x.fillStyle = color;
  x.font = 'italic 44px "Instrument Serif", Georgia, serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.setScalar(0.34);
  return s;
}

/* element colours (muted CPK) */
const RED = 0xc8503f;
const WHITE = 0xeeeeea;
const GREY = 0x4a4a4a;
const BOND = 0xb8b8b4;

function gearShape(teeth: number, rOut: number, rIn: number, hole: number): THREE.Shape {
  const s = new THREE.Shape();
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts: [number, number][] = [
      [a - step * 0.28, rIn],
      [a - step * 0.14, rOut],
      [a + step * 0.14, rOut],
      [a + step * 0.28, rIn],
    ];
    pts.forEach(([ang, r], k) => {
      const x = Math.cos(ang) * r;
      const y = Math.sin(ang) * r;
      if (i === 0 && k === 0) s.moveTo(x, y);
      else s.lineTo(x, y);
    });
  }
  s.closePath();
  const h = new THREE.Path();
  h.absarc(0, 0, hole, 0, Math.PI * 2, true);
  s.holes.push(h);
  return s;
}

/** Cheap deterministic "continents": sum of sines over the sphere. */
function landAt(x: number, y: number, z: number): number {
  return Math.sin(x * 2.3 + 1.1) * Math.sin(y * 2.1 - 0.4) + 0.6 * Math.sin(z * 3.1 + x * 1.7) + 0.35 * Math.sin(y * 5.3 + z * 2.2);
}

function earth(): Built {
  const g = new THREE.Group();
  const geo = new THREE.SphereGeometry(1, 64, 48);
  const pos = geo.attributes.position!;
  const colors = new Float32Array(pos.count * 3);
  const sea = new THREE.Color(0x2f6fb0);
  const shallow = new THREE.Color(0x3d86c6);
  const land = new THREE.Color(0x5f9a58);
  const hill = new THREE.Color(0x8d8f5c);
  const ice = new THREE.Color(0xf1f4f6);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const v = landAt(x, y, z);
    if (Math.abs(y) > 0.9) c.copy(ice);
    else if (v > 0.5) c.copy(land).lerp(hill, Math.min(1, (v - 0.5) * 1.4));
    else if (v > 0.38) c.copy(shallow).lerp(land, 0.5);
    else c.copy(sea).lerp(shallow, Math.max(0, v + 0.3) * 0.5);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 })));
  // atmosphere: a back-faced shell that glows at the rim
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(1.14, 48, 32),
    new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec3 vN; void main(){ float i = pow(0.72 - dot(vN, vec3(0.0,0.0,1.0)), 3.0); gl_FragColor = vec4(0.42,0.70,1.0, clamp(i,0.0,1.0)); }',
    }),
  );
  g.add(atmo);
  g.rotation.z = 0.41;
  return { group: g, distance: 4.8 };
}

function solarSystem(p: Palette): Built {
  const g = new THREE.Group();
  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 24), new THREE.MeshBasicMaterial({ color: 0xf2b84b }));
  g.add(sun);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.58, 32, 24), new THREE.MeshBasicMaterial({ color: 0xf2b84b, transparent: true, opacity: 0.18, depthWrite: false }));
  g.add(halo);
  const planets = [
    { r: 0.85, size: 0.1, color: 0xb59a86, speed: 1.6 },
    { r: 1.2, size: 0.16, color: 0x4f86c6, speed: 1.0 },
    { r: 1.65, size: 0.13, color: 0xc4684d, speed: 0.62 },
  ].map((d, i) => {
    g.add(ring(d.r, p.edge, 0.3));
    const m = sphere(d.size, d.color);
    g.add(m);
    return { m, ...d, phase: i * 2.1 };
  });
  g.rotation.x = 0.5;
  return {
    group: g,
    distance: 5.8,
    update: (t) => {
      for (const pl of planets) {
        const a = pl.phase + t * pl.speed * 0.6;
        pl.m.position.set(Math.cos(a) * pl.r, 0, Math.sin(a) * pl.r);
      }
    },
  };
}

function dna(): Built {
  const g = new THREE.Group();
  const n = 20;
  const rise = 0.15;
  const radius = 0.62;
  const turn = 0.62;
  const pairs = [0xc8503f, 0x4f86c6, 0xe0a948, 0x5f9a58];
  const a = std(0x4f86c6, { roughness: 0.4 });
  const b = std(0xc8503f, { roughness: 0.4 });
  const ball = new THREE.SphereGeometry(0.1, 16, 12);
  let prevA: THREE.Vector3 | null = null;
  let prevB: THREE.Vector3 | null = null;
  for (let i = 0; i < n; i++) {
    const y = (i - (n - 1) / 2) * rise;
    const ang = i * turn;
    const pa = new THREE.Vector3(Math.cos(ang) * radius, y, Math.sin(ang) * radius);
    const pb = new THREE.Vector3(Math.cos(ang + Math.PI) * radius, y, Math.sin(ang + Math.PI) * radius);
    const ma = new THREE.Mesh(ball, a);
    ma.position.copy(pa);
    const mb = new THREE.Mesh(ball, b);
    mb.position.copy(pb);
    g.add(ma, mb);
    if (prevA && prevB) g.add(rod(prevA, pa, 0.035, BOND), rod(prevB, pb, 0.035, BOND));
    // rung: half in each base colour
    const mid = new THREE.Vector3().addVectors(pa, pb).multiplyScalar(0.5);
    g.add(rod(pa, mid, 0.04, pairs[i % 4]!), rod(mid, pb, 0.04, pairs[(i + 2) % 4]!));
    prevA = pa;
    prevB = pb;
  }
  g.rotation.z = 0.35;
  return { group: g, distance: 6.6 };
}

function axes(p: Palette): Built {
  const g = new THREE.Group();
  const dirs: [THREE.Vector3, number, string][] = [
    [new THREE.Vector3(1, 0, 0), 0xc8503f, 'x'],
    [new THREE.Vector3(0, 1, 0), 0x5f9a58, 'y'],
    [new THREE.Vector3(0, 0, 1), 0x4f86c6, 'z'],
  ];
  const len = 1.1;
  const css = p.dark ? '#f2f2f0' : '#111111';
  for (const [d, color, name] of dirs) {
    const shaft = rod(new THREE.Vector3(), d.clone().multiplyScalar(len), 0.035, color);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28, 24), std(color));
    head.position.copy(d).multiplyScalar(len + 0.1);
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    const label = labelSprite(name, css);
    label.position.copy(d).multiplyScalar(len + 0.46);
    g.add(shaft, head, label);
  }
  g.add(sphere(0.06, p.solid));
  g.rotation.set(0.5, -0.6, 0);
  return { group: g, distance: 5.8 };
}

function atom(p: Palette): Built {
  const g = new THREE.Group();
  const nucleus = new THREE.Group();
  const spots: [number, number, number, number][] = [
    [0.1, 0.05, 0.08, RED], [-0.1, 0.08, -0.06, 0x4f86c6], [0.02, -0.12, 0.1, RED],
    [-0.08, -0.06, -0.1, 0x4f86c6], [0.12, -0.04, -0.09, 0x4f86c6], [-0.03, 0.13, 0.0, RED],
  ];
  for (const [x, y, z, c] of spots) {
    const m = sphere(0.13, c, { roughness: 0.4 });
    m.position.set(x, y, z);
    nucleus.add(m);
  }
  g.add(nucleus);
  const electrons: { m: THREE.Mesh; tilt: THREE.Group; speed: number; phase: number }[] = [];
  const tilts: [number, number][] = [[0, 0], [Math.PI / 3, Math.PI / 4], [-Math.PI / 3, -Math.PI / 4]];
  tilts.forEach(([rx, rz], i) => {
    const tilt = new THREE.Group();
    tilt.rotation.set(rx, 0, rz);
    const orbit = ring(1.15, p.edge, 0.45);
    orbit.scale.set(1, 1, 0.55);
    tilt.add(orbit);
    const e = sphere(0.07, 0x6aa6e8, { roughness: 0.3 });
    tilt.add(e);
    g.add(tilt);
    electrons.push({ m: e, tilt, speed: 1.8 - i * 0.35, phase: i * 2 });
  });
  return {
    group: g,
    distance: 4.9,
    update: (t) => {
      for (const el of electrons) {
        const a = el.phase + t * el.speed;
        el.m.position.set(Math.cos(a) * 1.15, 0, Math.sin(a) * 1.15 * 0.55);
      }
    },
  };
}

function h2o(): Built {
  const g = new THREE.Group();
  const O = new THREE.Vector3(0, 0.1, 0);
  const half = (104.5 / 2) * (Math.PI / 180);
  const hPos = [-1, 1].map((s) => new THREE.Vector3(Math.sin(half) * 0.98 * s, 0.1 - Math.cos(half) * 0.98, 0));
  const o = sphere(0.52, RED);
  o.position.copy(O);
  g.add(o);
  for (const h of hPos) {
    const m = sphere(0.3, WHITE, { roughness: 0.45 });
    m.position.copy(h);
    g.add(m, rod(O, h, 0.07, BOND));
  }
  g.position.y = 0.15;
  return { group: g, distance: 4.7 };
}

function co2(): Built {
  const g = new THREE.Group();
  const c = sphere(0.42, GREY);
  g.add(c);
  for (const s of [-1, 1]) {
    const o = sphere(0.5, RED);
    o.position.x = 1.4 * s;
    g.add(o);
    for (const off of [-0.07, 0.07]) {
      g.add(rod(new THREE.Vector3(0.3 * s, off, 0), new THREE.Vector3(1.2 * s, off, 0), 0.04, BOND));
    }
  }
  return { group: g, distance: 6.6 };
}

function gear(p: Palette): Built {
  const geo = new THREE.ExtrudeGeometry(gearShape(12, 1.15, 0.9, 0.38), { depth: 0.42, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 2, curveSegments: 24 });
  geo.center();
  const g = solid(geo, p);
  g.rotation.x = -0.35;
  const wrap = new THREE.Group();
  wrap.add(g);
  return { group: wrap, distance: 5.4, update: (t) => { g.rotation.z = t * 0.5; } };
}

export function buildModel(kind: Model3DKind, p: Palette): Built {
  switch (kind) {
    case 'cube': {
      const g = solid(new THREE.BoxGeometry(1.5, 1.5, 1.5), p);
      g.rotation.set(0.5, 0.6, 0);
      return { group: new THREE.Group().add(g) };
    }
    case 'sphere': {
      const g = solid(new THREE.SphereGeometry(1, 48, 32), p);
      const eq = ring(1.004, p.edge, 0.5);
      const mer = ring(1.004, p.edge, 0.5);
      mer.rotation.x = Math.PI / 2;
      g.add(eq, mer);
      return { group: new THREE.Group().add(g), distance: 4.8 };
    }
    case 'cylinder':
      return { group: new THREE.Group().add(solid(new THREE.CylinderGeometry(0.8, 0.8, 1.7, 48), p).rotateX(0.4)) };
    case 'cone':
      return { group: new THREE.Group().add(solid(new THREE.ConeGeometry(0.95, 1.8, 48), p).rotateX(0.35)) };
    case 'pyramid':
      return { group: new THREE.Group().add(solid(new THREE.ConeGeometry(1.15, 1.7, 4).rotateY(Math.PI / 4), p).rotateX(0.35)) };
    case 'torus':
      return { group: new THREE.Group().add(solid(new THREE.TorusGeometry(0.9, 0.36, 28, 72), p).rotateX(0.9)), distance: 5.6 };
    case 'molecule-h2o':
      return h2o();
    case 'molecule-co2':
      return co2();
    case 'atom':
      return atom(p);
    case 'gear':
      return gear(p);
    case 'planet-earth':
      return earth();
    case 'solar-system':
      return solarSystem(p);
    case 'dna-helix':
      return dna();
    case 'arrow-axes':
      return axes(p);
  }
}

/** Free every geometry / material / texture under an object. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      (mat as THREE.SpriteMaterial).map?.dispose?.();
      mat.dispose();
    }
  });
}
