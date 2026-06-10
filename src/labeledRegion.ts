import {
  FLOOR2D_STYLE,
  nextFloorStrokeColor,
  nextZoneStrokeColor,
  type FloorBlock,
  type FloorShape,
} from './floor2d';
import {
  boundsFromPoints,
  cloneZonePoints,
  dist2,
  isPolygonZone,
  pointInsideZone,
  resizeRectZone,
  syncZoneBounds,
  translateZone,
  zoneCentroid,
  type ZoneEditHandle,
  type ZonePoint,
} from './zoneGeometry';

export type RegionKind = 'zone' | 'floor';

export type RegionDrawMode = 'rectangle' | 'polygon';

export function regionStrokeColor(kind: RegionKind, index: number): string {
  return kind === 'floor' ? nextFloorStrokeColor(index) : nextZoneStrokeColor(index);
}

export function regionDefaultFill(kind: RegionKind): string {
  return kind === 'floor' ? FLOOR2D_STYLE.floorRegion : 'transparent';
}

export function regionLabelColor(kind: RegionKind, stroke: string): string {
  return kind === 'floor' ? FLOOR2D_STYLE.floorLabel : stroke;
}

export function cloneRegionBlock(block: FloorBlock): FloorBlock {
  return { ...block, points: cloneZonePoints(block.points) };
}

export function hitRegionHandle(
  blocks: FloorBlock[],
  selectedId: string | null,
  x: number,
  z: number,
  thresh: number,
): { block: FloorBlock; handle: ZoneEditHandle } | null {
  const selected = blocks.find((b) => b.id === selectedId);
  const order = selected ? [selected, ...blocks.filter((b) => b.id !== selected.id)] : [...blocks];
  const thresh2 = thresh * thresh;

  for (const block of order) {
    if (isPolygonZone(block) && block.points) {
      for (let i = 0; i < block.points.length; i++) {
        const p = block.points[i];
        if (dist2(x, z, p.x, p.z) <= thresh2) {
          return { block, handle: { kind: 'vertex', index: i } };
        }
      }
      continue;
    }
    const corners = [
      { corner: 'nw' as const, x: block.x, z: block.z },
      { corner: 'ne' as const, x: block.x + block.w, z: block.z },
      { corner: 'sw' as const, x: block.x, z: block.z + block.d },
      { corner: 'se' as const, x: block.x + block.w, z: block.z + block.d },
    ];
    for (const c of corners) {
      if (dist2(x, z, c.x, c.z) <= thresh2) {
        return { block, handle: { kind: 'resize', corner: c.corner } };
      }
    }
  }
  return null;
}

export function hitTestRegion(blocks: FloorBlock[], x: number, z: number): FloorBlock | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (pointInsideZone(x, z, blocks[i])) return blocks[i];
  }
  return null;
}

export function applyRegionEdit(
  block: FloorBlock,
  handle: ZoneEditHandle,
  snapshot: FloorBlock,
  startWorld: { x: number; z: number },
  x: number,
  z: number,
): void {
  const dx = x - startWorld.x;
  const dz = z - startWorld.z;
  if (handle.kind === 'move') {
    if (isPolygonZone(snapshot) && snapshot.points) {
      block.points = cloneZonePoints(snapshot.points)!;
      translateZone(block, dx, dz);
    } else {
      block.x = snapshot.x + dx;
      block.z = snapshot.z + dz;
      block.w = snapshot.w;
      block.d = snapshot.d;
    }
    return;
  }
  if (handle.kind === 'vertex' && snapshot.points) {
    block.points = cloneZonePoints(snapshot.points)!;
    block.points[handle.index].x = snapshot.points[handle.index].x + dx;
    block.points[handle.index].z = snapshot.points[handle.index].z + dz;
    syncZoneBounds(block);
    return;
  }
  if (handle.kind === 'resize') {
    block.x = snapshot.x;
    block.z = snapshot.z;
    block.w = snapshot.w;
    block.d = snapshot.d;
    resizeRectZone(block, handle.corner, x, z);
  }
}

export function makeRegionBlock(
  kind: RegionKind,
  rect: FloorBlock,
  name: string,
  shape: FloorShape,
  points: ZonePoint[] | undefined,
  index: number,
  floorY?: number,
): FloorBlock {
  const block: FloorBlock = {
    ...rect,
    id: `${kind}-${Date.now()}-${index}`,
    fill: regionDefaultFill(kind),
    label: name,
    shape,
    stroke: regionStrokeColor(kind, index),
    floorY,
  };
  if (shape === 'polygon' && points?.length) {
    block.points = points.map((p) => ({ x: p.x, z: p.z }));
    syncZoneBounds(block);
  }
  return block;
}

export function regionCentroid(block: FloorBlock): { x: number; z: number } {
  return zoneCentroid(block);
}

export function boundsFromRegionPoints(points: ZonePoint[]) {
  return boundsFromPoints(points);
}
