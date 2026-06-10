import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Floor2DMap, FloorBlock, WallSeg } from './floor2d';
import type { NavMapPoi } from './pois';
import { isPolygonZone, zoneCentroid } from './zoneGeometry';

/** Mappedin-style 3D floor palette (reference: soft white plan on gray canvas). */
const STYLE = {
  sceneBg: '#5a5f66',
  floor: '#c8c8c8',
  corridor: '#d0d0d0',
  borderWall: '#b8bcc4',
  borderWallTop: '#c9cdd4',
  /** Solid shaded interior room cubes (filled, not hollow outlines). */
  interiorBlock: '#a8adb5',
  interiorBlockTop: '#bcc1c8',
  interiorBlockSide: '#959aa3',
  /** Interior partition walls around filled blocks. */
  interiorWall: '#8f959e',
  interiorWallTop: '#7a8089',
  zoneLabel: '#4a5568',
  route: '#2563eb',
  routeOutline: '#ffffff',
  poi: '#78909c',
  poiLabel: '#37474f',
  origin: '#4caf50',
  destination: '#9c27b0',
  /** Default zone tints when no fill saved. */
  zoneTints: ['#d6e8ff', '#e8dcf5', '#dcefe8', '#f5e8dc', '#e0e8f5'],
} as const;

const BORDER_WALL_HEIGHT = 1.05;
const INTERIOR_WALL_HEIGHT = 0.4;
const INTERIOR_BLOCK_HEIGHT = 0.36;
const BORDER_WALL_THICKNESS = 0.09;
const INTERIOR_WALL_THICKNESS = 0.08;
const MIN_INTERIOR_VOID_CELLS = 2;
const FLOOR_THICKNESS = 0.06;
const ROUTE_LIFT = 0.12;
const ROUTE_RADIUS = 0.15;
const WALL_EPS = 1e-4;

function hex(color: string): THREE.Color {
  return new THREE.Color(color);
}

function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Sprite) {
      child.geometry?.dispose();
      const m = child.material;
      if (Array.isArray(m)) m.forEach((mat) => mat.dispose());
      else m?.dispose();
      if (child instanceof THREE.Sprite) {
        const map = (child.material as THREE.SpriteMaterial).map;
        map?.dispose();
      }
    } else if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
      child.geometry?.dispose();
      const m = child.material;
      if (Array.isArray(m)) (m as THREE.Material[]).forEach((mat) => mat.dispose());
      else (m as THREE.Material)?.dispose();
    }
  });
}

function walkAt(map: Floor2DMap, walk: Uint8Array, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return false;
  return walk[r * map.cols + c] === 1;
}

function cellAt(map: Floor2DMap, x: number, z: number): { c: number; r: number } | null {
  const c = Math.floor((x - map.minX) / map.cellSize);
  const r = Math.floor((z - map.minZ) / map.cellSize);
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return null;
  return { c, r };
}

function isBorderWallSegment(seg: WallSeg, map: Floor2DMap, walk: Uint8Array): boolean {
  const mx = (seg.x1 + seg.x2) / 2;
  const mz = (seg.z1 + seg.z2) / 2;
  const isVert = Math.abs(seg.x1 - seg.x2) < WALL_EPS;
  const step = map.cellSize * 0.28;
  const probes = isVert
    ? [
        { wx: mx - step, wz: mz },
        { wx: mx + step, wz: mz },
      ]
    : [
        { wx: mx, wz: mz - step },
        { wx: mx, wz: mz + step },
      ];

  let voidCell: { c: number; r: number } | null = null;
  for (const p of probes) {
    const cell = cellAt(map, p.wx, p.wz);
    if (!cell) return true;
    if (!walkAt(map, walk, cell.c, cell.r)) {
      voidCell = cell;
      break;
    }
  }
  if (!voidCell) return false;

  const visited = new Uint8Array(map.cols * map.rows);
  const queue: number[] = [voidCell.r * map.cols + voidCell.c];
  visited[queue[0]] = 1;
  while (queue.length) {
    const i = queue.shift()!;
    const c = i % map.cols;
    const r = (i / map.cols) | 0;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as [number, number][]) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= map.cols || nr >= map.rows) return true;
      const ni = nr * map.cols + nc;
      if (visited[ni] || walkAt(map, walk, nc, nr)) continue;
      visited[ni] = 1;
      queue.push(ni);
    }
  }
  return false;
}

function shadedWallMat(color: string, roughness = 0.9): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: hex(color),
    roughness,
    metalness: 0.02,
  });
}

function addWallSegment(
  group: THREE.Group,
  seg: WallSeg,
  floorY: number,
  border: boolean,
): void {
  const dx = seg.x2 - seg.x1;
  const dz = seg.z2 - seg.z1;
  const len = Math.hypot(dx, dz);
  if (len < WALL_EPS) return;

  const height = border ? BORDER_WALL_HEIGHT : INTERIOR_WALL_HEIGHT;
  const thickness = border ? BORDER_WALL_THICKNESS : INTERIOR_WALL_THICKNESS;
  const rotY = Math.atan2(dz, dx);
  const cx = (seg.x1 + seg.x2) / 2;
  const cz = (seg.z1 + seg.z2) / 2;

  if (border) {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(len, height, thickness),
      shadedWallMat(STYLE.borderWall, 0.93),
    );
    body.position.set(cx, floorY + height / 2, cz);
    body.rotation.y = rotY;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const top = new THREE.Mesh(
      new THREE.BoxGeometry(len + 0.015, 0.035, thickness + 0.015),
      shadedWallMat(STYLE.borderWallTop, 0.9),
    );
    top.position.set(cx, floorY + height + 0.018, cz);
    top.rotation.y = rotY;
    top.castShadow = true;
    group.add(top);
    return;
  }

  // Interior: thin partition rim around solid filled blocks (rendered separately).
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(len, height, thickness),
    shadedWallMat(STYLE.interiorWall, 0.88),
  );
  body.position.set(cx, floorY + height / 2, cz);
  body.rotation.y = rotY;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const top = new THREE.Mesh(
    new THREE.BoxGeometry(len + 0.01, 0.03, thickness + 0.01),
    shadedWallMat(STYLE.interiorWallTop, 0.85),
  );
  top.position.set(cx, floorY + height + 0.015, cz);
  top.rotation.y = rotY;
  top.castShadow = true;
  group.add(top);
}

/** Non-walk cells fully inside the map (not connected to outer void). */
function markEnclosedVoidCells(map: Floor2DMap, walk: Uint8Array): Uint8Array {
  const enclosed = new Uint8Array(map.cols * map.rows);
  const visited = new Uint8Array(map.cols * map.rows);

  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const start = r * map.cols + c;
      if (walk[start] || visited[start]) continue;

      const component: number[] = [];
      let touchesEdge = false;
      const queue = [start];
      visited[start] = 1;

      while (queue.length) {
        const i = queue.shift()!;
        component.push(i);
        const cc = i % map.cols;
        const rr = (i / map.cols) | 0;
        if (cc === 0 || rr === 0 || cc === map.cols - 1 || rr === map.rows - 1) touchesEdge = true;

        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as [number, number][]) {
          const nc = cc + dc;
          const nr = rr + dr;
          if (nc < 0 || nr < 0 || nc >= map.cols || nr >= map.rows) {
            touchesEdge = true;
            continue;
          }
          const ni = nr * map.cols + nc;
          if (visited[ni] || walk[ni]) continue;
          visited[ni] = 1;
          queue.push(ni);
        }
      }

      if (touchesEdge || component.length < MIN_INTERIOR_VOID_CELLS) continue;
      for (const i of component) enclosed[i] = 1;
    }
  }
  return enclosed;
}

/** Solid shaded cubes for enclosed interior rooms (not hollow wall outlines). */
function addEnclosedInteriorVolumes(
  group: THREE.Group,
  map: Floor2DMap,
  walk: Uint8Array,
  floorY: number,
): void {
  const enclosed = markEnclosedVoidCells(map, walk);
  const used = new Uint8Array(map.cols * map.rows);
  const cell = map.cellSize;
  const bodyMat = shadedWallMat(STYLE.interiorBlock, 0.9);
  const sideMat = shadedWallMat(STYLE.interiorBlockSide, 0.87);
  const topMat = shadedWallMat(STYLE.interiorBlockTop, 0.86);

  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const start = r * map.cols + c;
      if (!enclosed[start] || used[start]) continue;

      let w = 1;
      while (c + w < map.cols) {
        const i = r * map.cols + c + w;
        if (!enclosed[i] || used[i]) break;
        w++;
      }

      let h = 1;
      outer: while (r + h < map.rows) {
        for (let dc = 0; dc < w; dc++) {
          const i = (r + h) * map.cols + c + dc;
          if (!enclosed[i] || used[i]) break outer;
        }
        h++;
      }

      for (let dr = 0; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) used[(r + dr) * map.cols + c + dc] = 1;
      }

      const boxW = w * cell;
      const boxD = h * cell;
      const cx = map.minX + (c + w / 2) * cell;
      const cz = map.minZ + (r + h / 2) * cell;
      const inset = 0.04;

      const body = new THREE.Mesh(
        new THREE.BoxGeometry(boxW - inset, INTERIOR_BLOCK_HEIGHT, boxD - inset),
        bodyMat,
      );
      body.position.set(cx, floorY + INTERIOR_BLOCK_HEIGHT / 2, cz);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      const rimH = INTERIOR_WALL_HEIGHT - INTERIOR_BLOCK_HEIGHT;
      if (rimH > 0.02) {
        const rim = new THREE.Mesh(
          new THREE.BoxGeometry(boxW - inset * 0.5, rimH, boxD - inset * 0.5),
          sideMat,
        );
        rim.position.set(cx, floorY + INTERIOR_BLOCK_HEIGHT + rimH / 2, cz);
        rim.castShadow = true;
        group.add(rim);
      }

      const top = new THREE.Mesh(
        new THREE.BoxGeometry(boxW - inset * 0.3, 0.028, boxD - inset * 0.3),
        topMat,
      );
      top.position.set(cx, floorY + INTERIOR_WALL_HEIGHT + 0.014, cz);
      group.add(top);
    }
  }
}

function addWallMeshes(
  group: THREE.Group,
  walls: WallSeg[],
  map: Floor2DMap,
  walk: Uint8Array,
  floorY: number,
): void {
  for (const seg of walls) {
    addWallSegment(group, seg, floorY, isBorderWallSegment(seg, map, walk));
  }
}

function addBaseFloor(group: THREE.Group, map: Floor2DMap, floorY: number): void {
  const w = map.maxX - map.minX;
  const d = map.maxZ - map.minZ;
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(w, FLOOR_THICKNESS, d),
    new THREE.MeshStandardMaterial({
      color: hex(STYLE.floor),
      roughness: 0.96,
      metalness: 0,
    }),
  );
  slab.position.set((map.minX + map.maxX) / 2, floorY - FLOOR_THICKNESS / 2, (map.minZ + map.maxZ) / 2);
  slab.receiveShadow = true;
  group.add(slab);
}

function zoneTint(zone: FloorBlock, index: number): THREE.Color {
  if (zone.fill) return hex(zone.fill);
  if (zone.stroke) return hex(zone.stroke).lerp(hex('#ffffff'), 0.72);
  return hex(STYLE.zoneTints[index % STYLE.zoneTints.length]);
}

function addZoneFill(group: THREE.Group, zone: FloorBlock, floorY: number, tint: THREE.Color): void {
  const y = floorY + 0.028;
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.98,
    metalness: 0,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  if (isPolygonZone(zone) && zone.points && zone.points.length >= 3) {
    const shape = new THREE.Shape();
    shape.moveTo(zone.points[0].x, zone.points[0].z);
    for (let i = 1; i < zone.points.length; i++) shape.lineTo(zone.points[i].x, zone.points[i].z);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = y;
    group.add(mesh);
    return;
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(zone.w, 0.01, zone.d), mat);
  mesh.position.set(zone.x + zone.w / 2, y, zone.z + zone.d / 2);
  group.add(mesh);
}

function makeZoneLabelSprite(label: string, tint: THREE.Color): THREE.Sprite {
  const text = label.trim() || 'Zone';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const padX = 18;
  const fontSize = 22;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  const textW = ctx.measureText(text).width;
  const iconR = 16;
  const w = Math.ceil(Math.max(textW + padX * 2, 120));
  const h = 72;
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = 22;
  ctx.fillStyle = `#${tint.getHexString()}`;
  ctx.beginPath();
  ctx.arc(cx, cy, iconR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = STYLE.zoneLabel;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(text, cx, 44);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.55;
  sprite.scale.set(w * scale * 0.01, h * scale * 0.01, 1);
  return sprite;
}

function makePoiLabelSprite(name: string, color: string, highlight: boolean): THREE.Sprite {
  const text = (name.trim() || 'POI').slice(0, 28);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = highlight ? 20 : 18;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  const textW = ctx.measureText(text).width;
  const iconR = highlight ? 14 : 11;
  const w = Math.ceil(Math.max(textW + 28, 96));
  const h = 64;
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, 18, iconR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = STYLE.poiLabel;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(text, cx, 36);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const scale = highlight ? 0.52 : 0.46;
  sprite.scale.set(w * scale * 0.01, h * scale * 0.01, 1);
  return sprite;
}

function addZoneLabelsAndFills(group: THREE.Group, zones: FloorBlock[], floorY: number): void {
  zones.forEach((zone, i) => {
    const tint = zoneTint(zone, i);
    addZoneFill(group, zone, floorY, tint);
    if (!zone.label?.trim()) return;
    const c = zoneCentroid(zone);
    const sprite = makeZoneLabelSprite(zone.label, tint);
    sprite.position.set(c.x, floorY + 0.82 + (i % 2) * 0.1, c.z);
    group.add(sprite);
  });
}

function addWalkCorridorTint(
  group: THREE.Group,
  map: Floor2DMap,
  walk: Uint8Array,
  floorY: number,
): void {
  const cell = map.cellSize;
  const mat = new THREE.MeshStandardMaterial({
    color: hex(STYLE.corridor),
    roughness: 0.98,
    metalness: 0,
  });
  const geo = new THREE.BoxGeometry(cell * 0.99, 0.012, cell * 0.99);
  let count = 0;
  for (let i = 0; i < walk.length; i++) if (walk[i]) count++;
  if (!count) return;
  const inst = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  let idx = 0;
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      if (!walk[r * map.cols + c]) continue;
      m.makeTranslation(map.minX + (c + 0.5) * cell, floorY + 0.018, map.minZ + (r + 0.5) * cell);
      inst.setMatrixAt(idx++, m);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  group.add(inst);
}

function addObjectBlocks(group: THREE.Group, objects: FloorBlock[], floorY: number): void {
  for (const o of objects) {
    const h = 0.75;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(o.w, h, o.d),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 }),
    );
    mesh.position.set(o.x + o.w / 2, floorY + h / 2, o.z + o.d / 2);
    mesh.castShadow = true;
    group.add(mesh);
  }
}

export type Floor2DScene3dSync = {
  map: Floor2DMap;
  walk: Uint8Array;
  objects: FloorBlock[];
  zones: FloorBlock[];
  stores?: FloorBlock[];
  path: { x: number; z: number }[];
  pois: NavMapPoi[];
  originId: string;
  destId: string;
};

/** Mappedin-style 3D floor — soft plan, tall border walls, low interior partitions, zone fills. */
export class Floor2DScene3d {
  readonly domElement: HTMLCanvasElement;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly content: THREE.Group;
  private raf = 0;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.domElement = document.createElement('canvas');
    this.domElement.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:none;touch-action:none;z-index:2;';
    parent.appendChild(this.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = hex(STYLE.sceneBg);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.domElement, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.controls = new OrbitControls(this.camera, this.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 600;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.12;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(20, 40, 24);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 200;
    key.shadow.bias = -0.0002;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xd8e4ff, 0.28);
    fill.position.set(-16, 22, -20);
    this.scene.add(fill);

    this.content = new THREE.Group();
    this.scene.add(this.content);

    this.tick();
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.domElement.style.display = on ? 'block' : 'none';
    if (on) this.controls.update();
  }

  isVisible(): boolean {
    return this.visible;
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  sync(data: Floor2DScene3dSync, refitCamera = false): void {
    const { map, walk } = data;
    disposeObject3D(this.content);
    this.content.clear();

    const floorY = map.sliceY;
    addBaseFloor(this.content, map, floorY);
    addWalkCorridorTint(this.content, map, walk, floorY);
    addEnclosedInteriorVolumes(this.content, map, walk, floorY);
    addZoneLabelsAndFills(this.content, data.zones, floorY);
    addObjectBlocks(this.content, data.objects, floorY);
    addWallMeshes(this.content, map.walls, map, walk, floorY);
    this.addRoute(data.path, floorY);
    this.addPois(data.pois, data.originId, data.destId, floorY);
    if (refitCamera) this.fitCamera(map);
  }

  private addRoute(path: { x: number; z: number }[], floorY: number): void {
    if (path.length < 2) return;
    const y = floorY + ROUTE_LIFT;
    const up = new THREE.Vector3(0, 1, 0);
    // MeshBasicMaterial keeps the route vivid blue (StandardMaterial + white outline read as white).
    const routeMat = new THREE.MeshBasicMaterial({ color: hex(STYLE.route) });

    for (let i = 0; i < path.length - 1; i++) {
      const a = new THREE.Vector3(path[i].x, y, path[i].z);
      const b = new THREE.Vector3(path[i + 1].x, y, path[i + 1].z);
      const delta = b.clone().sub(a);
      const len = delta.length();
      if (len < 1e-5) continue;

      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = delta.normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);

      const seg = new THREE.Mesh(
        new THREE.CylinderGeometry(ROUTE_RADIUS, ROUTE_RADIUS, len, 12),
        routeMat,
      );
      seg.position.copy(mid);
      seg.quaternion.copy(quat);
      seg.renderOrder = 12;
      this.content.add(seg);
    }
  }

  private addPois(pois: NavMapPoi[], originId: string, destId: string, floorY: number): void {
    const group = new THREE.Group();
    for (const p of pois) {
      const isO = p.id === originId;
      const isD = p.id === destId;
      const color = isO ? STYLE.origin : isD ? STYLE.destination : STYLE.poi;
      const headR = isO || isD ? 0.2 : 0.15;
      const pinH = isO || isD ? 0.1 : 0.07;

      const pin = new THREE.Mesh(
        new THREE.CylinderGeometry(headR * 0.72, headR * 0.9, pinH, 16),
        new THREE.MeshStandardMaterial({ color: hex(color), roughness: 0.45 }),
      );
      pin.position.set(p.x, floorY + pinH / 2 + 0.02, p.z);
      group.add(pin);

      const head = new THREE.Mesh(
        new THREE.SphereGeometry(headR, 16, 16),
        new THREE.MeshStandardMaterial({ color: hex(color), roughness: 0.4 }),
      );
      head.position.set(p.x, floorY + pinH + headR + 0.02, p.z);
      group.add(head);

      const label = makePoiLabelSprite(p.name, color, isO || isD);
      label.position.set(p.x, floorY + pinH + headR * 2 + 0.28, p.z);
      group.add(label);
    }
    this.content.add(group);
  }

  private fitCamera(map: Floor2DMap): void {
    const cx = (map.minX + map.maxX) / 2;
    const cz = (map.minZ + map.maxZ) / 2;
    const span = Math.max(map.maxX - map.minX, map.maxZ - map.minZ, 8);
    const cy = map.sliceY + BORDER_WALL_HEIGHT * 0.25;
    this.controls.target.set(cx, cy, cz);
    const dist = span * 1.05;
    this.camera.position.set(cx + dist * 0.78, map.sliceY + dist * 0.68, cz + dist * 0.78);
    this.controls.update();
  }

  resetView(map: Floor2DMap): void {
    this.fitCamera(map);
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    if (!this.visible) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    disposeObject3D(this.content);
    this.renderer.dispose();
    this.domElement.remove();
  }
}
