import * as THREE from 'three';
import { forEachWorldTriangle } from './meshUtils';

export type FloorShape = 'rectangle' | 'circle' | 'polygon';

export type FloorPoint = { x: number; z: number };

export type FloorBlock = {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
  fill: string;
  label: string;
  shape?: FloorShape;
  /** Polygon vertices (world X/Z) when shape is polygon. */
  points?: FloorPoint[];
  /** Border color for labeled zones (dotted outline). */
  stroke?: string;
  /** Slice Y for named floor regions. */
  floorY?: number;
};

export type WallSeg = { x1: number; z1: number; x2: number; z2: number };

/** A named floor level at a fixed Y slice (not a drawn map region). */
export type FloorLevel = {
  id: string;
  label: string;
  floorY: number;
  /** Painted walk grid for this level (when grid size matches the map). */
  walkGrid?: number[];
  objects?: FloorBlock[];
  zones?: FloorBlock[];
  gridCols?: number;
  gridRows?: number;
  gridCellSize?: number;
  gridMinX?: number;
  gridMinZ?: number;
};

export function cloneFloorLevels(levels: FloorLevel[]): FloorLevel[] {
  return levels.map((f) => ({
    ...f,
    walkGrid: f.walkGrid ? [...f.walkGrid] : undefined,
    objects: f.objects?.map((o) => ({
      ...o,
      points: o.points?.map((p) => ({ x: p.x, z: p.z })),
    })),
    zones: f.zones?.map((z) => ({
      ...z,
      points: z.points?.map((p) => ({ x: p.x, z: p.z })),
    })),
  }));
}

export function floorLevelSliceMatches(map: Floor2DMap, floor: FloorLevel): boolean {
  return Math.abs(floor.floorY - map.sliceY) < 1e-4;
}

export function floorLevelGridMatches(map: Floor2DMap, floor: FloorLevel): boolean {
  if (!floorLevelSliceMatches(map, floor)) return false;
  if (!Array.isArray(floor.walkGrid) || floor.walkGrid.length !== map.cols * map.rows) return false;
  if (floor.gridCols !== map.cols || floor.gridRows !== map.rows) return false;
  if (floor.gridCellSize !== undefined && Math.abs(floor.gridCellSize - map.cellSize) > 1e-6) return false;
  if (floor.gridMinX !== undefined && Math.abs(floor.gridMinX - map.minX) > 1e-3) return false;
  if (floor.gridMinZ !== undefined && Math.abs(floor.gridMinZ - map.minZ) > 1e-3) return false;
  return true;
}

export function defaultFloorLabel(index: number): string {
  return `Floor ${index}`;
}

export type Floor2DMap = {
  sliceY: number;
  cellSize: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  /** Walkable corridor polygons (mall concourse). */
  corridors: FloorBlock[];
  /** Room / store units along corridors. */
  stores: FloorBlock[];
  /** Solid obstacle blocks (rectangle / circle). */
  objects: FloorBlock[];
  /** Labeled regions — dotted colorful outline, not walkable edits. */
  zones: FloorBlock[];
  /** Named building levels — each level is a slice Y (e.g. Ground Floor, Floor 2). */
  floors: FloorLevel[];
  /** @deprecated use corridors */
  blocks: FloorBlock[];
  walls: WallSeg[];
};

/** Mappedin-style mall palette (light floor, gray zones, purple labels). */
export const FLOOR2D_STYLE = {
  background: '#f5f5f5',
  corridor: '#f5f5f5',
  /** Auto-detected room/store fill — muted gray (not heavy). */
  store: '#ececec',
  object: '#ffffff',
  objectBorder: '#999999',
  objectLabel: '#9c27b0',
  wall: '#808080',
  wallLight: '#999999',
  route: '#3b6fd9',
  routeOutline: '#ffffff',
  routeDot: '#2a55b8',
  zoneLabel: '#8a7a96',
  navMesh: 'rgba(156,39,176,0.12)',
  navMeshStroke: 'rgba(156,39,176,0.35)',
  poiLabel: '#9c27b0',
  poiMarker: '#e0e0e0',
  poiMarkerBorder: '#ffffff',
  accent: '#8e7d9a',
  origin: '#4caf50',
  destination: '#9c27b0',
  /** Muted zone outline + label hues (dark family, lower saturation). */
  zoneStrokeColors: ['#8e7d9a', '#a08978', '#6f858a', '#9a7a84', '#7a8f7e', '#7a849c'],
  /** Draw opacity for zone outlines and labels (0–1). */
  zoneStrokeOpacity: 0.72,
  floorRegion: 'rgba(33,150,243,0.18)',
  floorRegionBorder: '#2196f3',
  floorLabel: '#1565c0',
  floorStrokeColors: ['#2196f3', '#00897b', '#5c6bc0', '#00acc1', '#43a047', '#6d4c41'],
} as const;

const CORRIDOR_FILL = FLOOR2D_STYLE.corridor;
const STORE_FILL = FLOOR2D_STYLE.store;
const EPS = 1e-4;

function pointInTri2D(px: number, pz: number, ax: number, az: number, bx: number, bz: number, cx: number, cz: number): boolean {
  const v0x = cx - ax;
  const v0z = cz - az;
  const v1x = bx - ax;
  const v1z = bz - az;
  const v2x = px - ax;
  const v2z = pz - az;
  const dot00 = v0x * v0x + v0z * v0z;
  const dot01 = v0x * v1x + v0z * v1z;
  const dot02 = v0x * v2x + v0z * v2z;
  const dot11 = v1x * v1x + v1z * v1z;
  const dot12 = v1x * v2x + v1z * v2z;
  const inv = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(inv) < 1e-12) return false;
  const u = (dot11 * dot02 - dot01 * dot12) / inv;
  const v = (dot00 * dot12 - dot01 * dot02) / inv;
  return u >= 0 && v >= 0 && u + v <= 1;
}

function rasterizeTriXZ(
  grid: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  value: number,
): void {
  const tminX = Math.min(ax, bx, cx);
  const tmaxX = Math.max(ax, bx, cx);
  const tminZ = Math.min(az, bz, cz);
  const tmaxZ = Math.max(az, bz, cz);
  const c0 = Math.max(0, Math.floor((tminX - minX) / cell));
  const c1 = Math.min(cols - 1, Math.floor((tmaxX - minX) / cell));
  const r0 = Math.max(0, Math.floor((tminZ - minZ) / cell));
  const r1 = Math.min(rows - 1, Math.floor((tmaxZ - minZ) / cell));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const px = minX + (c + 0.5) * cell;
      const pz = minZ + (r + 0.5) * cell;
      if (pointInTri2D(px, pz, ax, az, bx, bz, cx, cz)) {
        grid[r * cols + c] = Math.max(grid[r * cols + c], value);
      }
    }
  }
}

function mergeRects(mask: Uint8Array, cols: number, rows: number, minX: number, minZ: number, cell: number): FloorBlock[] {
  const used = new Uint8Array(mask.length);
  const blocks: FloorBlock[] = [];
  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (mask[i] === 0 || used[i]) continue;
      let w = 1;
      while (c + w < cols && mask[r * cols + c + w] && !used[r * cols + c + w]) w++;
      let h = 1;
      outer: while (r + h < rows) {
        for (let cc = 0; cc < w; cc++) {
          const ii = (r + h) * cols + c + cc;
          if (!mask[ii] || used[ii]) break outer;
        }
        h++;
      }
      for (let dr = 0; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) used[(r + dr) * cols + c + dc] = 1;
      }
      blocks.push({
        id: `block-${id++}`,
        x: minX + c * cell,
        z: minZ + r * cell,
        w: w * cell,
        d: h * cell,
        fill: CORRIDOR_FILL,
        label: '',
      });
    }
  }
  return blocks;
}

function extractStoreMask(walk: Uint8Array, cols: number, rows: number): Uint8Array {
  const stores = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (walk[i]) continue;
      let touchesWalk = false;
      if (r > 0 && walk[(r - 1) * cols + c]) touchesWalk = true;
      else if (r + 1 < rows && walk[(r + 1) * cols + c]) touchesWalk = true;
      else if (c > 0 && walk[r * cols + c - 1]) touchesWalk = true;
      else if (c + 1 < cols && walk[r * cols + c + 1]) touchesWalk = true;
      if (touchesWalk) stores[i] = 1;
    }
  }
  return stores;
}

function mergeStoreRects(mask: Uint8Array, cols: number, rows: number, minX: number, minZ: number, cell: number): FloorBlock[] {
  const used = new Uint8Array(mask.length);
  const blocks: FloorBlock[] = [];
  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (mask[i] === 0 || used[i]) continue;
      let w = 1;
      while (c + w < cols && mask[r * cols + c + w] && !used[r * cols + c + w]) w++;
      let h = 1;
      outer: while (r + h < rows) {
        for (let cc = 0; cc < w; cc++) {
          const ii = (r + h) * cols + c + cc;
          if (!mask[ii] || used[ii]) break outer;
        }
        h++;
      }
      for (let dr = 0; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) used[(r + dr) * cols + c + dc] = 1;
      }
      blocks.push({
        id: `store-${id++}`,
        x: minX + c * cell,
        z: minZ + r * cell,
        w: w * cell,
        d: h * cell,
        fill: STORE_FILL,
        label: '',
      });
    }
  }
  return blocks;
}

function extractOrthogonalWalls(
  walk: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
): WallSeg[] {
  const raw: WallSeg[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const left = c > 0 ? walk[r * cols + c - 1] : 0;
      const right = c < cols ? walk[r * cols + c] : 0;
      if (!left && !right) continue;
      if (left !== right) {
        const x = minX + c * cell;
        raw.push({ x1: x, z1: minZ + r * cell, x2: x, z2: minZ + (r + 1) * cell });
      }
    }
  }
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < cols; c++) {
      const up = r > 0 ? walk[(r - 1) * cols + c] : 0;
      const down = r < rows ? walk[r * cols + c] : 0;
      if (!up && !down) continue;
      if (up !== down) {
        const z = minZ + r * cell;
        raw.push({ x1: minX + c * cell, z1: z, x2: minX + (c + 1) * cell, z2: z });
      }
    }
  }
  return mergeOrthogonalSegments(raw);
}

function mergeOrthogonalSegments(segs: WallSeg[]): WallSeg[] {
  const horiz: { z: number; x0: number; x1: number }[] = [];
  const vert: { x: number; z0: number; z1: number }[] = [];
  for (const s of segs) {
    if (Math.abs(s.z1 - s.z2) < EPS) {
      horiz.push({ z: s.z1, x0: Math.min(s.x1, s.x2), x1: Math.max(s.x1, s.x2) });
    } else if (Math.abs(s.x1 - s.x2) < EPS) {
      vert.push({ x: s.x1, z0: Math.min(s.z1, s.z2), z1: Math.max(s.z1, s.z2) });
    }
  }
  horiz.sort((a, b) => a.z - b.z || a.x0 - b.x0);
  vert.sort((a, b) => a.x - b.x || a.z0 - b.z0);

  const mergedH: typeof horiz = [];
  for (const h of horiz) {
    const last = mergedH[mergedH.length - 1];
    if (last && Math.abs(last.z - h.z) < EPS && h.x0 <= last.x1 + EPS) {
      last.x1 = Math.max(last.x1, h.x1);
    } else mergedH.push({ ...h });
  }
  const mergedV: typeof vert = [];
  for (const v of vert) {
    const last = mergedV[mergedV.length - 1];
    if (last && Math.abs(last.x - v.x) < EPS && v.z0 <= last.z1 + EPS) {
      last.z1 = Math.max(last.z1, v.z1);
    } else mergedV.push({ ...v });
  }

  const out: WallSeg[] = [];
  for (const h of mergedH) out.push({ x1: h.x0, z1: h.z, x2: h.x1, z2: h.z });
  for (const v of mergedV) out.push({ x1: v.x, z1: v.z0, x2: v.x, z2: v.z1 });
  return out;
}

export function buildFloor2DFromMap(
  mapRoot: THREE.Object3D,
  sliceY: number,
  options: { cellSize?: number; band?: number } = {},
): Floor2DMap {
  const cellSize = options.cellSize ?? 0.12;
  const band = options.band ?? 0.45;

  const box = new THREE.Box3().setFromObject(mapRoot);
  if (box.isEmpty()) {
    return {
      sliceY,
      cellSize,
      minX: -10,
      maxX: 10,
      minZ: -10,
      maxZ: 10,
      cols: 1,
      rows: 1,
      corridors: [],
      stores: [],
      objects: [],
      zones: [],
      floors: [],
      blocks: [],
      walls: [],
    };
  }

  const pad = 0.5;
  const minX = box.min.x - pad;
  const maxX = box.max.x + pad;
  const minZ = box.min.z - pad;
  const maxZ = box.max.z + pad;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  const walk = new Uint8Array(cols * rows);

  forEachWorldTriangle(mapRoot, (a, b, c, n) => {
    const yMin = Math.min(a.y, b.y, c.y);
    const yMax = Math.max(a.y, b.y, c.y);
    if (yMax < sliceY - band || yMin > sliceY + band) return;
    if (n.y > 0.35) {
      rasterizeTriXZ(walk, cols, rows, minX, minZ, cellSize, a.x, a.z, b.x, b.z, c.x, c.z, 1);
    }
  });

  let walkable = walk;
  if (walkable.every((v) => v === 0)) {
    walkable = new Uint8Array(cols * rows);
    forEachWorldTriangle(mapRoot, (a, b, c) => {
      const yMin = Math.min(a.y, b.y, c.y);
      const yMax = Math.max(a.y, b.y, c.y);
      if (yMax < sliceY - band || yMin > sliceY + band) return;
      rasterizeTriXZ(walkable, cols, rows, minX, minZ, cellSize, a.x, a.z, b.x, b.z, c.x, c.z, 1);
    });
  }

  const corridors = mergeRects(walkable, cols, rows, minX, minZ, cellSize);
  const storeMask = extractStoreMask(walkable, cols, rows);
  const stores = mergeStoreRects(storeMask, cols, rows, minX, minZ, cellSize);
  const walls = extractOrthogonalWalls(walkable, cols, rows, minX, minZ, cellSize);

  return {
    sliceY,
    cellSize,
    minX,
    maxX,
    minZ,
    maxZ,
    cols,
    rows,
    corridors,
    stores,
    objects: [],
    zones: [],
    floors: [],
    blocks: corridors,
    walls,
  };
}

function blocksToWalkGrid(map: Floor2DMap, blocks: FloorBlock[]): Uint8Array {
  const walk = new Uint8Array(map.cols * map.rows);
  const cell = map.cellSize;
  for (const b of blocks) {
    paintRectOnWalk(map, walk, b, 1);
  }
  return walk;
}

/** Build a walk grid from corridor blocks (clone for editing). */
export function walkGridFromBlocks(map: Floor2DMap, blocks: FloorBlock[]): Uint8Array {
  return blocksToWalkGrid(map, blocks);
}

/** Paint a world-space rectangle onto the walk grid (1 = floor, 0 = empty). */
export function paintRectOnWalk(map: Floor2DMap, walk: Uint8Array, rect: FloorBlock, value: 0 | 1): void {
  const cell = map.cellSize;
  const c0 = Math.max(0, Math.floor((rect.x - map.minX) / cell));
  const c1 = Math.min(map.cols - 1, Math.ceil((rect.x + rect.w - map.minX) / cell) - 1);
  const r0 = Math.max(0, Math.floor((rect.z - map.minZ) / cell));
  const r1 = Math.min(map.rows - 1, Math.ceil((rect.z + rect.d - map.minZ) / cell) - 1);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      walk[r * map.cols + c] = value;
    }
  }
}

/** Rebuild walls/stores from an edited walk grid, objects, and labeled zones. */
export function applyWalkGridEdits(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[] = [],
  zones: FloorBlock[] = [],
  floors: FloorLevel[] = [],
): Floor2DMap {
  const merged = mergeRects(walk, map.cols, map.rows, map.minX, map.minZ, map.cellSize);
  const storeMask = extractStoreMask(walk, map.cols, map.rows);
  const stores = mergeStoreRects(storeMask, map.cols, map.rows, map.minX, map.minZ, map.cellSize);
  const walls = extractOrthogonalWalls(walk, map.cols, map.rows, map.minX, map.minZ, map.cellSize);
  return {
    ...map,
    corridors: merged,
    blocks: merged,
    stores,
    objects: objects.map((o) => ({ ...o })),
    zones: zones.map((z) => ({ ...z })),
    floors: cloneFloorLevels(floors),
    walls,
  };
}

/** Rebuild walls/stores from edited corridor blocks and return updated map. */
export function applyCorridorEdits(map: Floor2DMap, corridors: FloorBlock[]): Floor2DMap {
  return applyWalkGridEdits(map, blocksToWalkGrid(map, corridors));
}

/** True when a world X/Z point lies inside a floor block (rectangle or circle bbox). */
export function pointInsideBlock(x: number, z: number, block: FloorBlock): boolean {
  if (block.shape === 'circle') {
    const cx = block.x + block.w * 0.5;
    const cz = block.z + block.d * 0.5;
    const rx = block.w * 0.5;
    const rz = block.d * 0.5;
    if (rx < 1e-6 || rz < 1e-6) return false;
    const dx = (x - cx) / rx;
    const dz = (z - cz) / rz;
    return dx * dx + dz * dz <= 1;
  }
  return x >= block.x && x <= block.x + block.w && z >= block.z && z <= block.z + block.d;
}

export function nextZoneStrokeColor(index: number): string {
  const colors = FLOOR2D_STYLE.zoneStrokeColors;
  return colors[index % colors.length];
}

export function nextFloorStrokeColor(index: number): string {
  const colors = FLOOR2D_STYLE.floorStrokeColors;
  return colors[index % colors.length];
}

/** POI display name for a store/object zone (explicit label, else matching POI name). */
export function zoneDisplayLabel(
  block: FloorBlock,
  pois: { name: string; x: number; z: number }[],
): string {
  if (block.label.trim()) return block.label.trim();
  for (let i = 0; i < pois.length; i++) {
    const p = pois[i];
    if (pointInsideBlock(p.x, p.z, block)) return p.name;
  }
  return '';
}
