import type { Floor2DMap, FloorBlock } from './floor2d';
import { pointInsideBlock } from './floor2d';

export type FloorPathPoint = { x: number; y: number; z: number };

type Cell = { c: number; r: number };

const NEIGHBORS_8: { dc: number; dr: number; cost: number }[] = [
  { dc: 1, dr: 0, cost: 1 },
  { dc: -1, dr: 0, cost: 1 },
  { dc: 0, dr: 1, cost: 1 },
  { dc: 0, dr: -1, cost: 1 },
  { dc: 1, dr: 1, cost: Math.SQRT2 },
  { dc: 1, dr: -1, cost: Math.SQRT2 },
  { dc: -1, dr: 1, cost: Math.SQRT2 },
  { dc: -1, dr: -1, cost: Math.SQRT2 },
];

function cellIndex(map: Floor2DMap, c: number, r: number): number {
  return r * map.cols + c;
}

export function worldToCell(map: Floor2DMap, x: number, z: number): Cell | null {
  const c = Math.floor((x - map.minX) / map.cellSize);
  const r = Math.floor((z - map.minZ) / map.cellSize);
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return null;
  return { c, r };
}

export function cellCenter(map: Floor2DMap, c: number, r: number): { x: number; z: number } {
  return {
    x: map.minX + (c + 0.5) * map.cellSize,
    z: map.minZ + (r + 0.5) * map.cellSize,
  };
}

function cellBlockedByObject(x: number, z: number, objects: FloorBlock[]): boolean {
  for (let i = 0; i < objects.length; i++) {
    if (pointInsideBlock(x, z, objects[i])) return true;
  }
  return false;
}

/** Walkable floor cells: painted walk grid minus solid objects. */
export function buildFloorNavGrid(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
): Uint8Array {
  const nav = new Uint8Array(map.cols * map.rows);
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const i = cellIndex(map, c, r);
      if (!walk[i]) continue;
      const { x, z } = cellCenter(map, c, r);
      if (cellBlockedByObject(x, z, objects)) continue;
      nav[i] = 1;
    }
  }
  return nav;
}

function isWalkable(nav: Uint8Array, map: Floor2DMap, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return false;
  return nav[cellIndex(map, c, r)] === 1;
}

/** BFS to nearest walkable cell from a world point. */
export function nearestWalkableCell(
  map: Floor2DMap,
  nav: Uint8Array,
  x: number,
  z: number,
  maxCells = 128,
): Cell | null {
  const start = worldToCell(map, x, z);
  if (!start) return null;
  if (isWalkable(nav, map, start.c, start.r)) return start;

  const visited = new Uint8Array(map.cols * map.rows);
  const queue: Cell[] = [start];
  visited[cellIndex(map, start.c, start.r)] = 1;
  let qi = 0;
  let steps = 0;

  while (qi < queue.length && steps < maxCells * maxCells) {
    const { c, r } = queue[qi++];
    steps++;
    for (const { dc, dr } of NEIGHBORS_8) {
      const nc = c + dc;
      const nr = r + dr;
      if (!isWalkable(nav, map, nc, nr)) continue;
      return { c: nc, r: nr };
    }
    for (const { dc, dr } of NEIGHBORS_8) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= map.cols || nr >= map.rows) continue;
      const ni = cellIndex(map, nc, nr);
      if (visited[ni]) continue;
      visited[ni] = 1;
      queue.push({ c: nc, r: nr });
    }
  }
  return null;
}

export function snapWorldToWalkCell(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  x: number,
  z: number,
): { x: number; z: number } | null {
  const nav = buildFloorNavGrid(map, walk, objects);
  const cell = nearestWalkableCell(map, nav, x, z);
  if (!cell) return null;
  return cellCenter(map, cell.c, cell.r);
}

function heuristic(a: Cell, b: Cell): number {
  const dc = Math.abs(a.c - b.c);
  const dr = Math.abs(a.r - b.r);
  return Math.max(dc, dr) + (Math.SQRT2 - 1) * Math.min(dc, dr);
}

function reconstructPath(cameFrom: Int32Array, endIdx: number, map: Floor2DMap): Cell[] {
  const cells: Cell[] = [];
  let cur = endIdx;
  while (cur >= 0) {
    const r = Math.floor(cur / map.cols);
    const c = cur % map.cols;
    cells.push({ c, r });
    cur = cameFrom[cur];
  }
  cells.reverse();
  return cells;
}

function simplifyCollinear(cells: Cell[]): Cell[] {
  if (cells.length <= 2) return cells;
  const out: Cell[] = [cells[0]];
  for (let i = 1; i < cells.length - 1; i++) {
    const a = out[out.length - 1];
    const b = cells[i];
    const c = cells[i + 1];
    const cross = (b.c - a.c) * (c.r - a.r) - (b.r - a.r) * (c.c - a.c);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(cells[cells.length - 1]);
  return out;
}

function cellsToWorldPath(cells: Cell[], map: Floor2DMap, floorY: number): FloorPathPoint[] {
  return cells.map(({ c, r }) => {
    const { x, z } = cellCenter(map, c, r);
    return { x, y: floorY, z };
  });
}

/** A* on the 2D walk grid — route stays on painted floor, not through objects. */
export function findPathOnFloorGrid(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  floorY: number,
): { path: FloorPathPoint[] } | { error: string } {
  const nav = buildFloorNavGrid(map, walk, objects);
  const walkableCount = nav.reduce((n, v) => n + (v ? 1 : 0), 0);
  if (walkableCount < 2) {
    return { error: 'No walkable floor — paint floor with Paint Floor first' };
  }

  const startCell = nearestWalkableCell(map, nav, startX, startZ);
  const endCell = nearestWalkableCell(map, nav, endX, endZ);
  if (!startCell) return { error: 'Origin is not on walkable floor' };
  if (!endCell) return { error: 'Destination is not on walkable floor' };

  const startIdx = cellIndex(map, startCell.c, startCell.r);
  const endIdx = cellIndex(map, endCell.c, endCell.r);
  if (startIdx === endIdx) {
    return { path: cellsToWorldPath([startCell], map, floorY) };
  }

  const total = map.cols * map.rows;
  const gScore = new Float32Array(total);
  gScore.fill(Infinity);
  const fScore = new Float32Array(total);
  fScore.fill(Infinity);
  const cameFrom = new Int32Array(total);
  cameFrom.fill(-1);
  const closed = new Uint8Array(total);

  gScore[startIdx] = 0;
  fScore[startIdx] = heuristic(startCell, endCell);

  const open: number[] = [startIdx];

  while (open.length > 0) {
    open.sort((a, b) => fScore[a] - fScore[b]);
    const current = open.shift()!;
    if (current === endIdx) {
      const cells = simplifyCollinear(reconstructPath(cameFrom, endIdx, map));
      return { path: cellsToWorldPath(cells, map, floorY) };
    }
    if (closed[current]) continue;
    closed[current] = 1;

    const cr = Math.floor(current / map.cols);
    const cc = current % map.cols;

    for (const { dc, dr, cost } of NEIGHBORS_8) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (!isWalkable(nav, map, nc, nr)) continue;

      if (dc !== 0 && dr !== 0) {
        if (!isWalkable(nav, map, cc + dc, cr) || !isWalkable(nav, map, cc, cr + dr)) continue;
      }

      const neighbor = cellIndex(map, nc, nr);
      if (closed[neighbor]) continue;

      const tentative = gScore[current] + cost;
      if (tentative >= gScore[neighbor]) continue;

      cameFrom[neighbor] = current;
      gScore[neighbor] = tentative;
      fScore[neighbor] = tentative + heuristic({ c: nc, r: nr }, endCell);
      if (!open.includes(neighbor)) open.push(neighbor);
    }
  }

  return { error: 'No path on floor — cut a corridor or move obstacles' };
}
