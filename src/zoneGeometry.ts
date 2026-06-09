import { pointInsideBlock, type FloorBlock } from './floor2d';

export type ZonePoint = { x: number; z: number };

export type ZoneResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

export type ZoneEditHandle =
  | { kind: 'move' }
  | { kind: 'resize'; corner: ZoneResizeCorner }
  | { kind: 'vertex'; index: number };

export function isPolygonZone(block: FloorBlock): boolean {
  return block.shape === 'polygon' && !!block.points && block.points.length >= 3;
}

export function cloneZonePoints(points: ZonePoint[] | undefined): ZonePoint[] | undefined {
  return points?.map((p) => ({ x: p.x, z: p.z }));
}

export function syncZoneBounds(block: FloorBlock): void {
  if (!isPolygonZone(block) || !block.points?.length) return;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of block.points) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  block.x = minX;
  block.z = minZ;
  block.w = Math.max(0, maxX - minX);
  block.d = Math.max(0, maxZ - minZ);
}

export function zoneCentroid(block: FloorBlock): { x: number; z: number } {
  if (isPolygonZone(block) && block.points) {
    let sx = 0;
    let sz = 0;
    for (const p of block.points) {
      sx += p.x;
      sz += p.z;
    }
    return { x: sx / block.points.length, z: sz / block.points.length };
  }
  return { x: block.x + block.w * 0.5, z: block.z + block.d * 0.5 };
}

export function pointInPolygon(x: number, z: number, points: ZonePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const zi = points[i].z;
    const xj = points[j].x;
    const zj = points[j].z;
    const intersect =
      zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInsideZone(x: number, z: number, block: FloorBlock): boolean {
  if (isPolygonZone(block) && block.points) return pointInPolygon(x, z, block.points);
  return pointInsideBlock(x, z, block);
}

export function translateZone(block: FloorBlock, dx: number, dz: number): void {
  if (isPolygonZone(block) && block.points) {
    for (const p of block.points) {
      p.x += dx;
      p.z += dz;
    }
    syncZoneBounds(block);
    return;
  }
  block.x += dx;
  block.z += dz;
}

export function resizeRectZone(
  block: FloorBlock,
  corner: ZoneResizeCorner,
  anchorX: number,
  anchorZ: number,
): void {
  const x0 = block.x;
  const z0 = block.z;
  const x1 = block.x + block.w;
  const z1 = block.z + block.d;
  let nx0 = x0;
  let nz0 = z0;
  let nx1 = x1;
  let nz1 = z1;
  if (corner === 'nw') {
    nx0 = anchorX;
    nz0 = anchorZ;
  } else if (corner === 'ne') {
    nx1 = anchorX;
    nz0 = anchorZ;
  } else if (corner === 'sw') {
    nx0 = anchorX;
    nz1 = anchorZ;
  } else {
    nx1 = anchorX;
    nz1 = anchorZ;
  }
  block.x = Math.min(nx0, nx1);
  block.z = Math.min(nz0, nz1);
  block.w = Math.abs(nx1 - nx0);
  block.d = Math.abs(nz1 - nz0);
}

export function boundsFromPoints(points: ZonePoint[]): { x: number; z: number; w: number; d: number } {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  return { x: minX, z: minZ, w: Math.max(0, maxX - minX), d: Math.max(0, maxZ - minZ) };
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}
