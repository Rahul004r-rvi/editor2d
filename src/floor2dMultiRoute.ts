import type { NavMesh } from 'recast-navigation';
import type { Floor2DMap, FloorBlock, FloorLevel } from './floor2d';
import { applyWalkGridEdits } from './floor2d';
import {
  buildFloorNavGrid,
  cellCenter,
  findPathOnFloorGrid,
  snapWorldToWalkCell,
  type FloorPathPoint,
} from './floor2dRoute';
import { floorLevelForPoiY } from './pois';
import { computeNavigationRoutePath } from './navmeshSnap';
import { NAV_MESH_QUERY_HALF_EXTENTS } from './config';

export type FloorRouteSegment = {
  floorId: string;
  floorY: number;
  label: string;
  path: FloorPathPoint[];
};

/** Nav-mesh path on the stair slope between two flat floors. */
export type FloorRouteConnector = {
  fromFloorId: string;
  toFloorId: string;
  from: { x: number; z: number };
  to: { x: number; z: number };
  via: { x: number; y: number; z: number }[];
};

/** Where forward / reverse probes disagree or needed a floor-grid bridge. */
export type RouteBreakPoint = {
  floorId: string;
  floorY: number;
  x: number;
  z: number;
  label: string;
};

export type MultiFloorRoutePlan = {
  multiFloor: boolean;
  segments: FloorRouteSegment[];
  connectors: FloorRouteConnector[];
  error?: string;
  /** Origin → destination probe (dashed green on map). */
  debugForward?: FloorRouteSegment[];
  /** Destination → origin probe (dashed orange on map). */
  debugReverse?: FloorRouteSegment[];
  breakPoints?: RouteBreakPoint[];
};

const STAIR_Y_MARGIN = 0.35;
const LANDING_MISMATCH = 1.75;
/** Min horizontal span between stair mouths — below this is a vertical shortcut (not real stairs). */
const MIN_STAIR_XZ = 0.85;
/** POI closer than this to a vertical mouth pair is treated as a forbidden plumb-line drop. */
const POI_PLUMB_RADIUS = 2.0;
const STAIR_MOUTH_FLOOR_SAMPLES = 96;
const STAIR_PORTAL_PROBE_LIMIT = 64;
const STAIR_PORTAL_GRID_CANDIDATES = 12;

type StairPortal = {
  from: { x: number; z: number };
  to: { x: number; z: number };
};

const stairPortalCache = new Map<string, StairPortal>();

export function clearStairPortalCache(): void {
  stairPortalCache.clear();
}

function stairPortalCacheKey(fromFloorId: string, toFloorId: string): string {
  return `${fromFloorId}\0${toFloorId}`;
}

type Vec3 = { x: number; y: number; z: number };

type FloorLeg = {
  floor: FloorLevel;
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
};

type OneWayPlan = {
  multiFloor: boolean;
  segments: FloorRouteSegment[];
  connectors: FloorRouteConnector[];
  legs: FloorLeg[];
  error?: string;
};

function floorForY(y: number, floors: FloorLevel[]): FloorLevel | null {
  return floorLevelForPoiY(y, floors);
}

export function getFloorWalkGrid(map: Floor2DMap, floor: FloorLevel): Uint8Array | null {
  if (
    !floor.walkGrid ||
    floor.gridCols !== map.cols ||
    floor.gridRows !== map.rows ||
    floor.walkGrid.length !== map.cols * map.rows
  ) {
    return null;
  }
  return new Uint8Array(floor.walkGrid.map((v) => (v ? 1 : 0)));
}

function segmentLabel(floor: FloorLevel): string {
  return floor.label.trim() || 'Floor';
}

function distXZ(
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function reversePath(path: FloorPathPoint[]): FloorPathPoint[] {
  return [...path].reverse();
}

function pathXZ(path: FloorPathPoint[]): { x: number; z: number }[] {
  return path.map((p) => ({ x: p.x, z: p.z }));
}

function dedupePathPoints(path: { x: number; z: number }[]): { x: number; z: number }[] {
  if (path.length < 2) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const prev = out[out.length - 1];
    if (distXZ(path[i], prev) > 0.05) out.push(path[i]);
  }
  return out.length >= 2 ? out : path;
}

function setPathEndpoint(
  path: { x: number; z: number }[],
  point: { x: number; z: number },
  end: 'start' | 'end',
): { x: number; z: number }[] {
  if (path.length === 0) return [{ ...point }];
  const out = path.map((p) => ({ ...p }));
  const i = end === 'start' ? 0 : out.length - 1;
  out[i] = { x: point.x, z: point.z };
  return out;
}

/** Full per-floor path for 3D plates — snap to stair mouths, no nearest-index trim. */
export function pathForFloor3dPlate(
  floorId: string,
  segment: FloorRouteSegment | undefined,
  connectors: FloorRouteConnector[],
): { x: number; z: number }[] {
  if (!segment || segment.path.length < 2) return [];
  let path = pathXZ(segment.path);

  for (const link of connectors) {
    if (link.toFloorId === floorId) {
      path = setPathEndpoint(path, { x: link.to.x, z: link.to.z }, 'start');
    }
    if (link.fromFloorId === floorId) {
      path = setPathEndpoint(path, { x: link.from.x, z: link.from.z }, 'end');
    }
  }

  return dedupePathPoints(path);
}

function nearestIndexTowardStart(
  path: { x: number; z: number }[],
  x: number,
  z: number,
): number {
  const limit = Math.min(path.length, Math.max(3, Math.ceil(path.length * 0.45)));
  let best = 0;
  let bestD = distXZ(path[0], { x, z });
  for (let i = 1; i < limit; i++) {
    const d = distXZ(path[i], { x, z });
    if (d < bestD - 0.02) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function nearestIndexTowardEnd(
  path: { x: number; z: number }[],
  x: number,
  z: number,
): number {
  const start = Math.max(0, path.length - Math.max(3, Math.ceil(path.length * 0.45)));
  let best = path.length - 1;
  let bestD = distXZ(path[best], { x, z });
  for (let i = start; i < path.length - 1; i++) {
    const d = distXZ(path[i], { x, z });
    if (d < bestD - 0.02 || (d <= bestD + 0.05 && i > best)) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Trim a floor segment for 2D plate drawing (inbound mouth first, then outbound). */
export function trimPathForFloorPlate(
  floorId: string,
  path: FloorPathPoint[],
  connectors: FloorRouteConnector[],
): FloorPathPoint[] {
  if (path.length < 2) return path;
  let out = [...path];

  for (const link of connectors) {
    if (link.toFloorId !== floorId) continue;
    const idx = nearestIndexTowardStart(out, link.to.x, link.to.z);
    out = out.slice(idx);
  }
  for (const link of connectors) {
    if (link.fromFloorId !== floorId) continue;
    const idx = nearestIndexTowardEnd(out, link.from.x, link.from.z);
    out = out.slice(0, idx + 1);
  }

  return out.length >= 2 ? out : path;
}

function multiFloorHalfExtents(floors: FloorLevel[]): { x: number; y: number; z: number } {
  const ys = floors.map((f) => f.floorY);
  const span = ys.length ? Math.max(...ys) - Math.min(...ys) : 8;
  return {
    x: NAV_MESH_QUERY_HALF_EXTENTS.x,
    y: Math.max(16, span + 8),
    z: NAV_MESH_QUERY_HALF_EXTENTS.z,
  };
}

function discoveryTouchesFloor(path: Vec3[], floorId: string, floors: FloorLevel[]): boolean {
  return path.some((p) => floorForY(p.y, floors)?.id === floorId);
}

function extractConnectorEndpoints(
  path: Vec3[],
  floors: FloorLevel[],
): Omit<FloorRouteConnector, 'via'>[] {
  const connectors: Omit<FloorRouteConnector, 'via'>[] = [];
  if (path.length < 2 || floors.length < 2) return connectors;

  let prevFloor = floorForY(path[0].y, floors);
  for (let i = 1; i < path.length; i++) {
    const curFloor = floorForY(path[i].y, floors);
    if (!prevFloor || !curFloor || prevFloor.id === curFloor.id) continue;
    connectors.push({
      fromFloorId: prevFloor.id,
      toFloorId: curFloor.id,
      from: { x: path[i - 1].x, z: path[i - 1].z },
      to: { x: path[i].x, z: path[i].z },
    });
    prevFloor = curFloor;
  }
  return connectors;
}

function resampleStairPoints(a: Vec3, b: Vec3, steps: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    out.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    });
  }
  return out;
}

function stairViaPoints(path: Vec3[], fromFloor: FloorLevel, toFloor: FloorLevel): Vec3[] {
  if (path.length < 2) return [];
  const low = Math.min(fromFloor.floorY, toFloor.floorY);
  const high = Math.max(fromFloor.floorY, toFloor.floorY);

  const onSlope = path.filter((p) => p.y > low + STAIR_Y_MARGIN && p.y < high - STAIR_Y_MARGIN);
  if (onSlope.length >= 2) return onSlope;

  const inner = path.slice(1, -1);
  if (inner.length >= 2) return inner;
  if (inner.length === 1) return inner;

  return resampleStairPoints(path[0], path[path.length - 1], 10);
}

/** Slope points from the full O→D nav-mesh discovery path (follows real stairs). */
function extractDiscoveryStairVia(
  path: Vec3[],
  fromFloorId: string,
  toFloorId: string,
  floors: FloorLevel[],
): Vec3[] {
  for (let i = 1; i < path.length; i++) {
    const prevF = floorForY(path[i - 1].y, floors);
    const curF = floorForY(path[i].y, floors);
    if (prevF?.id !== fromFloorId || curF?.id !== toFloorId) continue;

    let start = i - 1;
    for (let s = i - 2; s >= 0; s--) {
      if (floorForY(path[s].y, floors)?.id === fromFloorId) start = s;
      else break;
    }
    let end = i;
    for (let e = i + 1; e < path.length; e++) {
      if (floorForY(path[e].y, floors)?.id === toFloorId) end = e;
      else break;
    }

    const chunk = path.slice(start, end + 1);
    if (chunk.length >= 3) return chunk.slice(1, -1);
    if (chunk.length === 2) return resampleStairPoints(chunk[0], chunk[1], 10);
    return [];
  }

  const fromFloor = floors.find((f) => f.id === fromFloorId);
  const toFloor = floors.find((f) => f.id === toFloorId);
  if (!fromFloor || !toFloor) return [];

  const lo = Math.min(fromFloor.floorY, toFloor.floorY);
  const hi = Math.max(fromFloor.floorY, toFloor.floorY);
  const between = path.filter((p) => p.y >= lo - 0.05 && p.y <= hi + 0.05);
  if (between.length >= 3) return between.slice(1, -1);
  if (between.length === 2) return resampleStairPoints(between[0], between[1], 10);
  return [];
}

function pathXZTravel(pts: { x: number; z: number }[]): number {
  return pts.reduce((sum, p, i) => (i === 0 ? 0 : sum + distXZ(p, pts[i - 1])), 0);
}

function isVerticalStairShortcut(
  from: { x: number; z: number },
  to: { x: number; z: number },
): boolean {
  return distXZ(from, to) < MIN_STAIR_XZ;
}

function stairNavHasSlope(
  stair: FloorRouteConnector,
  fromFloor: FloorLevel,
  toFloor: FloorLevel,
): boolean {
  void fromFloor;
  void toFloor;
  const mouthXZ = distXZ(stair.from, stair.to);
  const viaXZ = pathXZTravel(stair.via);
  return mouthXZ >= MIN_STAIR_XZ || viaXZ >= MIN_STAIR_XZ;
}

/** Nav-mesh hole under a POI (Primary suite / Closet) — same XZ drop, not real stairs. */
function isPlumbDropAtPoi(
  origin: Vec3,
  destination: Vec3,
  from: { x: number; z: number },
  to: { x: number; z: number },
  fromFloor: FloorLevel,
  toFloor: FloorLevel,
): boolean {
  if (!isVerticalStairShortcut(from, to)) return false;
  const originOnFrom = Math.abs(origin.y - fromFloor.floorY) < 0.6;
  const destOnTo = Math.abs(destination.y - toFloor.floorY) < 0.6;
  if (originOnFrom && distXZ(origin, from) < POI_PLUMB_RADIUS) return true;
  if (destOnTo && distXZ(destination, to) < POI_PLUMB_RADIUS) return true;
  return false;
}

function isRejectedStairMouthPair(
  origin: Vec3,
  destination: Vec3,
  from: { x: number; z: number },
  to: { x: number; z: number },
  fromFloor: FloorLevel,
  toFloor: FloorLevel,
): boolean {
  if (isPlumbDropAtPoi(origin, destination, from, to, fromFloor, toFloor)) return true;
  if (isVerticalStairShortcut(from, to)) return true;
  return false;
}

function floorGridPathLength(
  map: Floor2DMap,
  floor: FloorLevel,
  floors: FloorLevel[],
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): number {
  const out = routeOnFloorGrid(
    map,
    floor,
    floors,
    startX,
    startZ,
    endX,
    endZ,
    activeWalk,
    activeFloorId,
  );
  if ('error' in out) return Infinity;
  if (out.path.length < 2) return Infinity;
  let len = 0;
  for (let i = 1; i < out.path.length; i++) {
    len += distXZ(out.path[i - 1], out.path[i]);
  }
  return len;
}

function sampleAllWalkCells(
  floorMap: Floor2DMap,
  nav: Uint8Array,
  maxSamples: number,
): { c: number; r: number }[] {
  const out: { c: number; r: number }[] = [];
  const total = floorMap.cols * floorMap.rows;
  const stride = Math.max(1, Math.floor(Math.sqrt(total / maxSamples)));
  for (let r = 0; r < floorMap.rows; r += stride) {
    for (let c = 0; c < floorMap.cols; c += stride) {
      if (nav[r * floorMap.cols + c]) out.push({ c, r });
    }
  }
  return out;
}

/** Last flat point before the slope on upper floor + first flat point after on lower floor. */
function extractSlopeStairMouths(
  path: Vec3[],
  fromFloor: FloorLevel,
  toFloor: FloorLevel,
  floors: FloorLevel[],
): Omit<FloorRouteConnector, 'via'> | null {
  const lo = Math.min(fromFloor.floorY, toFloor.floorY);
  const hi = Math.max(fromFloor.floorY, toFloor.floorY);

  let slopeStart = -1;
  let slopeEnd = -1;
  for (let i = 0; i < path.length; i++) {
    const y = path[i].y;
    if (y > lo + STAIR_Y_MARGIN && y < hi - STAIR_Y_MARGIN) {
      if (slopeStart < 0) slopeStart = i;
      slopeEnd = i;
    }
  }
  if (slopeStart < 0) return null;

  let topIdx = slopeStart - 1;
  while (topIdx >= 0 && floorForY(path[topIdx].y, floors)?.id !== fromFloor.id) topIdx--;
  const topMouth = topIdx >= 0 ? path[topIdx] : path[slopeStart];

  let bottomIdx = slopeEnd + 1;
  while (bottomIdx < path.length && floorForY(path[bottomIdx].y, floors)?.id !== toFloor.id) {
    bottomIdx++;
  }
  const bottomMouth =
    bottomIdx < path.length ? path[bottomIdx] : path[slopeEnd];

  const from = { x: topMouth.x, z: topMouth.z };
  const to = { x: bottomMouth.x, z: bottomMouth.z };
  if (isVerticalStairShortcut(from, to) && pathXZTravel(path.slice(slopeStart, slopeEnd + 1)) < MIN_STAIR_XZ) {
    return null;
  }

  return {
    fromFloorId: fromFloor.id,
    toFloorId: toFloor.id,
    from,
    to,
  };
}

function bestTransitionFromDiscovery(
  path: Vec3[],
  fromFloor: FloorLevel,
  toFloor: FloorLevel,
  floors: FloorLevel[],
): Omit<FloorRouteConnector, 'via'> | null {
  let best: Omit<FloorRouteConnector, 'via'> | null = null;
  let bestSpan = 0;

  for (let i = 1; i < path.length; i++) {
    const prevF = floorForY(path[i - 1].y, floors);
    const curF = floorForY(path[i].y, floors);
    if (prevF?.id !== fromFloor.id || curF?.id !== toFloor.id) continue;

    const from = { x: path[i - 1].x, z: path[i - 1].z };
    const to = { x: path[i].x, z: path[i].z };
    const span = distXZ(from, to);
    if (span > bestSpan) {
      bestSpan = span;
      best = { fromFloorId: fromFloor.id, toFloorId: toFloor.id, from, to };
    }
  }

  return bestSpan >= MIN_STAIR_XZ ? best : null;
}

/** Cached building-wide stair portal (real stairs, independent of POI position). */
function discoverGlobalStairPortal(
  navMesh: NavMesh,
  map: Floor2DMap,
  floors: FloorLevel[],
  fromFloor: FloorLevel,
  toFloor: FloorLevel,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): StairPortal | null {
  const cacheKey = stairPortalCacheKey(fromFloor.id, toFloor.id);
  const cached = stairPortalCache.get(cacheKey);
  if (cached) return cached;

  const fromMap = previewMapForFloor(map, fromFloor, floors);
  const toMap = previewMapForFloor(map, toFloor, floors);
  const fromWalk = resolveFloorWalk(map, fromFloor, activeWalk, activeFloorId);
  const toWalk = resolveFloorWalk(map, toFloor, activeWalk, activeFloorId);
  if (!fromWalk || !toWalk) return null;

  const fromNav = buildFloorNavGrid(fromMap, fromWalk, fromFloor.objects ?? []);
  const toNav = buildFloorNavGrid(toMap, toWalk, toFloor.objects ?? []);

  const upperCells = sampleAllWalkCells(fromMap, fromNav, STAIR_MOUTH_FLOOR_SAMPLES);
  const lowerCells = sampleAllWalkCells(toMap, toNav, STAIR_MOUTH_FLOOR_SAMPLES);
  if (upperCells.length === 0 || lowerCells.length === 0) return null;

  const upperStride = Math.max(1, Math.ceil(upperCells.length / STAIR_PORTAL_GRID_CANDIDATES));
  const lowerStride = Math.max(1, Math.ceil(lowerCells.length / STAIR_PORTAL_GRID_CANDIDATES));

  let best: StairPortal | null = null;
  let bestSpan = 0;
  let probes = 0;

  for (let ui = 0; ui < upperCells.length && probes < STAIR_PORTAL_PROBE_LIMIT; ui += upperStride) {
    const u = cellCenter(fromMap, upperCells[ui].c, upperCells[ui].r);
    for (let li = 0; li < lowerCells.length && probes < STAIR_PORTAL_PROBE_LIMIT; li += lowerStride) {
      probes++;
      const l = cellCenter(toMap, lowerCells[li].c, lowerCells[li].r);
      if (isVerticalStairShortcut(u, l)) continue;

      const stair = computeStairNavPath(navMesh, floors, {
        fromFloorId: fromFloor.id,
        toFloorId: toFloor.id,
        from: u,
        to: l,
      });
      if ('error' in stair) continue;
      if (!stairNavHasSlope(stair, fromFloor, toFloor)) continue;

      const span = distXZ(u, l) + pathXZTravel(stair.via);
      if (span > bestSpan) {
        bestSpan = span;
        best = { from: u, to: l };
      }
    }
  }

  if (best) stairPortalCache.set(cacheKey, best);
  return best;
}

function portalLink(
  fromFloor: FloorLevel,
  toFloor: FloorLevel,
  portal: StairPortal,
): Omit<FloorRouteConnector, 'via'> {
  return {
    fromFloorId: fromFloor.id,
    toFloorId: toFloor.id,
    from: portal.from,
    to: portal.to,
  };
}

function portalReachableFromEndpoints(
  map: Floor2DMap,
  floors: FloorLevel[],
  fromFloor: FloorLevel,
  toFloor: FloorLevel,
  portal: StairPortal,
  origin: Vec3,
  destination: Vec3,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): boolean {
  const toUpper = floorGridPathLength(
    map,
    fromFloor,
    floors,
    origin.x,
    origin.z,
    portal.from.x,
    portal.from.z,
    activeWalk,
    activeFloorId,
  );
  const toLower = floorGridPathLength(
    map,
    toFloor,
    floors,
    portal.to.x,
    portal.to.z,
    destination.x,
    destination.z,
    activeWalk,
    activeFloorId,
  );
  return Number.isFinite(toUpper) && Number.isFinite(toLower);
}

/** Find stair mouths on walk grid when discovery takes a vertical shortcut (e.g. Primary suite). */
function findStairMouthsViaWalkGrid(
  navMesh: NavMesh,
  map: Floor2DMap,
  floors: FloorLevel[],
  fromFloor: FloorLevel,
  toFloor: FloorLevel,
  origin: Vec3,
  destination: Vec3,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): Omit<FloorRouteConnector, 'via'> | null {
  const portal = discoverGlobalStairPortal(
    navMesh,
    map,
    floors,
    fromFloor,
    toFloor,
    activeWalk,
    activeFloorId,
  );
  if (!portal) return null;

  if (
    !isRejectedStairMouthPair(origin, destination, portal.from, portal.to, fromFloor, toFloor) &&
    portalReachableFromEndpoints(
      map,
      floors,
      fromFloor,
      toFloor,
      portal,
      origin,
      destination,
      activeWalk,
      activeFloorId,
    )
  ) {
    return portalLink(fromFloor, toFloor, portal);
  }

  const fromMap = previewMapForFloor(map, fromFloor, floors);
  const toMap = previewMapForFloor(map, toFloor, floors);
  const fromWalk = resolveFloorWalk(map, fromFloor, activeWalk, activeFloorId);
  const toWalk = resolveFloorWalk(map, toFloor, activeWalk, activeFloorId);
  if (!fromWalk || !toWalk) return null;

  const fromNav = buildFloorNavGrid(fromMap, fromWalk, fromFloor.objects ?? []);
  const toNav = buildFloorNavGrid(toMap, toWalk, toFloor.objects ?? []);
  const upperCells = sampleAllWalkCells(fromMap, fromNav, 48);
  const lowerCells = sampleAllWalkCells(toMap, toNav, 48);
  const upperStride = Math.max(1, Math.ceil(upperCells.length / 8));
  const lowerStride = Math.max(1, Math.ceil(lowerCells.length / 8));

  let best: { portal: StairPortal; cost: number } | null = null;
  let probes = 0;

  for (let ui = 0; ui < upperCells.length && probes < STAIR_PORTAL_PROBE_LIMIT; ui += upperStride) {
    const u = cellCenter(fromMap, upperCells[ui].c, upperCells[ui].r);
    for (let li = 0; li < lowerCells.length && probes < STAIR_PORTAL_PROBE_LIMIT; li += lowerStride) {
      probes++;
      const lc = lowerCells[li];
      const l = cellCenter(toMap, lc.c, lc.r);
      if (isRejectedStairMouthPair(origin, destination, u, l, fromFloor, toFloor)) continue;

      const stair = computeStairNavPath(navMesh, floors, {
        fromFloorId: fromFloor.id,
        toFloorId: toFloor.id,
        from: u,
        to: l,
      });
      if ('error' in stair) continue;
      if (!stairNavHasSlope(stair, fromFloor, toFloor)) continue;

      const toUpper = floorGridPathLength(
        map,
        fromFloor,
        floors,
        origin.x,
        origin.z,
        u.x,
        u.z,
        activeWalk,
        activeFloorId,
      );
      const toLower = floorGridPathLength(
        map,
        toFloor,
        floors,
        l.x,
        l.z,
        destination.x,
        destination.z,
        activeWalk,
        activeFloorId,
      );
      if (!Number.isFinite(toUpper) || !Number.isFinite(toLower)) continue;

      const cost = toUpper + toLower;
      if (!best || cost < best.cost) best = { portal: { from: u, to: l }, cost };
    }
  }

  if (!best) {
    if (
      portalReachableFromEndpoints(
        map,
        floors,
        fromFloor,
        toFloor,
        portal,
        origin,
        destination,
        activeWalk,
        activeFloorId,
      )
    ) {
      return portalLink(fromFloor, toFloor, portal);
    }
    return null;
  }

  return portalLink(fromFloor, toFloor, best.portal);
}

/**
 * Resolve stair mouths before the steps on each floor.
 * Origin/dest floor legs use floor grid; only the connector uses nav mesh on stairs.
 */
function resolveStairMouthLink(
  discoveryPath: Vec3[],
  navMesh: NavMesh,
  map: Floor2DMap,
  floors: FloorLevel[],
  fromFloor: FloorLevel,
  toFloor: FloorLevel,
  origin: Vec3,
  destination: Vec3,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): Omit<FloorRouteConnector, 'via'> | { error: string } {
  const fromSlope = extractSlopeStairMouths(discoveryPath, fromFloor, toFloor, floors);
  if (
    fromSlope &&
    !isRejectedStairMouthPair(
      origin,
      destination,
      fromSlope.from,
      fromSlope.to,
      fromFloor,
      toFloor,
    )
  ) {
    return fromSlope;
  }

  const fromTransition = bestTransitionFromDiscovery(discoveryPath, fromFloor, toFloor, floors);
  if (
    fromTransition &&
    !isRejectedStairMouthPair(
      origin,
      destination,
      fromTransition.from,
      fromTransition.to,
      fromFloor,
      toFloor,
    )
  ) {
    return fromTransition;
  }

  const fromGrid = findStairMouthsViaWalkGrid(
    navMesh,
    map,
    floors,
    fromFloor,
    toFloor,
    origin,
    destination,
    activeWalk,
    activeFloorId,
  );
  if (fromGrid) return fromGrid;

  return { error: `No stair connection found for ${segmentLabel(fromFloor)} → ${segmentLabel(toFloor)}` };
}

function mergeStairVia(discoveryPath: Vec3[], meshVia: Vec3[], link: Omit<FloorRouteConnector, 'via'>, floors: FloorLevel[]): Vec3[] {
  const fromDiscovery = extractDiscoveryStairVia(discoveryPath, link.fromFloorId, link.toFloorId, floors);
  const xzLength = (pts: Vec3[]) => pathXZTravel(pts);

  if (fromDiscovery.length >= 2 && xzLength(fromDiscovery) > 0.2) return fromDiscovery;
  if (meshVia.length >= 2 && xzLength(meshVia) > 0.2) return meshVia;
  if (fromDiscovery.length >= 1) return fromDiscovery;
  if (meshVia.length >= 1) return meshVia;
  return [];
}

function computeStairNavPath(
  navMesh: NavMesh,
  floors: FloorLevel[],
  link: Omit<FloorRouteConnector, 'via'>,
): FloorRouteConnector | { error: string } {
  const fromFloor = floors.find((f) => f.id === link.fromFloorId);
  const toFloor = floors.find((f) => f.id === link.toFloorId);
  if (!fromFloor || !toFloor) return { error: 'Unknown floor in stair link' };

  const stairOut = computeNavigationRoutePath(
    navMesh,
    [
      { x: link.from.x, y: fromFloor.floorY, z: link.from.z, isCamera: false },
      { x: link.to.x, y: toFloor.floorY, z: link.to.z, isCamera: false },
    ],
    { halfExtents: multiFloorHalfExtents(floors), softenCorners: true },
  );

  if ('error' in stairOut || stairOut.path.length < 2) {
    return { error: 'No nav mesh path on stairs between floors' };
  }

  return {
    fromFloorId: link.fromFloorId,
    toFloorId: link.toFloorId,
    from: { ...link.from },
    to: { ...link.to },
    via: stairViaPoints(stairOut.path, fromFloor, toFloor),
  };
}

function resolveFloorWalk(
  map: Floor2DMap,
  floor: FloorLevel,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): Uint8Array | null {
  const saved = getFloorWalkGrid(map, floor);
  if (saved) return saved;
  if (activeFloorId === floor.id && activeWalk && activeWalk.length === map.cols * map.rows) {
    return activeWalk;
  }
  return null;
}

function routeOnFloorGrid(
  map: Floor2DMap,
  floor: FloorLevel,
  allFloors: FloorLevel[],
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): { path: FloorPathPoint[] } | { error: string } {
  const walk = resolveFloorWalk(map, floor, activeWalk, activeFloorId);
  if (!walk) {
    return { error: `Paint walkable floor on ${segmentLabel(floor)} first` };
  }
  const floorMap = previewMapForFloor(map, floor, allFloors);
  const objects = floor.objects ?? [];
  return findPathOnFloorGrid(
    floorMap,
    walk,
    objects,
    startX,
    startZ,
    endX,
    endZ,
    floor.floorY,
  );
}

function snapLandingToWalk(
  map: Floor2DMap,
  floor: FloorLevel,
  allFloors: FloorLevel[],
  x: number,
  z: number,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): { x: number; z: number } {
  const walk = resolveFloorWalk(map, floor, activeWalk, activeFloorId);
  if (!walk) return { x, z };
  const floorMap = previewMapForFloor(map, floor, allFloors);
  const snapped = snapWorldToWalkCell(floorMap, walk, floor.objects ?? [], x, z);
  return snapped ?? { x, z };
}

function buildFloorChain(
  floors: FloorLevel[],
  originFloor: FloorLevel,
  destFloor: FloorLevel,
  connectors: FloorRouteConnector[],
): FloorLevel[] {
  const byId = new Map(floors.map((f) => [f.id, f]));
  const chain: FloorLevel[] = [originFloor];
  let currentId = originFloor.id;

  for (let guard = 0; guard < connectors.length + 2 && currentId !== destFloor.id; guard++) {
    const link = connectors.find((c) => c.fromFloorId === currentId);
    if (!link) break;
    const next = byId.get(link.toFloorId);
    if (!next) break;
    if (chain[chain.length - 1]?.id !== next.id) chain.push(next);
    currentId = next.id;
  }

  if (chain[chain.length - 1]?.id !== destFloor.id) chain.push(destFloor);
  return chain;
}

function buildFloorLegs(
  chain: FloorLevel[],
  connectors: FloorRouteConnector[],
  origin: Vec3,
  destination: Vec3,
): FloorLeg[] {
  const legs: FloorLeg[] = [];
  for (let i = 0; i < chain.length; i++) {
    const floor = chain[i];
    const prev = i > 0 ? chain[i - 1] : null;
    const next = i < chain.length - 1 ? chain[i + 1] : null;

    let startX = origin.x;
    let startZ = origin.z;
    let endX = destination.x;
    let endZ = destination.z;

    if (prev) {
      const inbound = connectors.find(
        (c) => c.fromFloorId === prev.id && c.toFloorId === floor.id,
      );
      if (!inbound) return legs;
      startX = inbound.to.x;
      startZ = inbound.to.z;
    }
    if (next) {
      const outbound = connectors.find(
        (c) => c.fromFloorId === floor.id && c.toFloorId === next.id,
      );
      if (!outbound) return legs;
      endX = outbound.from.x;
      endZ = outbound.from.z;
    }

    legs.push({ floor, startX, startZ, endX, endZ });
  }
  return legs;
}

function buildOneWayHybridPlan(
  map: Floor2DMap,
  floors: FloorLevel[],
  navMesh: NavMesh | null,
  origin: Vec3,
  destination: Vec3,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
  activeObjects: FloorBlock[],
): OneWayPlan {
  const originFloor = floorForY(origin.y, floors);
  const destFloor = floorForY(destination.y, floors);
  const sameFloor =
    floors.length <= 1 || (originFloor && destFloor && originFloor.id === destFloor.id);

  if (sameFloor) {
    const floor = originFloor ?? destFloor ?? floors[0] ?? null;
    if (floor) {
      const out = routeOnFloorGrid(
        map,
        floor,
        floors,
        origin.x,
        origin.z,
        destination.x,
        destination.z,
        activeWalk,
        activeFloorId,
      );
      if ('error' in out) {
        return { multiFloor: false, segments: [], connectors: [], legs: [], error: out.error };
      }
      if (out.path.length < 2) {
        return { multiFloor: false, segments: [], connectors: [], legs: [], error: 'No path on floor' };
      }
      return {
        multiFloor: false,
        segments: [
          {
            floorId: floor.id,
            floorY: floor.floorY,
            label: segmentLabel(floor),
            path: out.path,
          },
        ],
        connectors: [],
        legs: [
          {
            floor,
            startX: origin.x,
            startZ: origin.z,
            endX: destination.x,
            endZ: destination.z,
          },
        ],
      };
    }

    if (!activeWalk) {
      return {
        multiFloor: false,
        segments: [],
        connectors: [],
        legs: [],
        error: 'No walkable floor — paint floor with Paint Floor first',
      };
    }
    const out = findPathOnFloorGrid(
      map,
      activeWalk,
      activeObjects,
      origin.x,
      origin.z,
      destination.x,
      destination.z,
      origin.y,
    );
    if ('error' in out) {
      return { multiFloor: false, segments: [], connectors: [], legs: [], error: out.error };
    }
    return {
      multiFloor: false,
      segments: out.path.length >= 2 ? [{ floorId: 'floor-0', floorY: origin.y, label: 'Floor', path: out.path }] : [],
      connectors: [],
      legs: [],
      error: out.path.length < 2 ? 'No path on floor' : undefined,
    };
  }

  if (!navMesh || !originFloor || !destFloor) {
    return {
      multiFloor: true,
      segments: [],
      connectors: [],
      legs: [],
      error: !navMesh ? 'Nav mesh not built yet' : 'Could not determine floor levels',
    };
  }

  const discovery = computeNavigationRoutePath(
    navMesh,
    [
      { x: origin.x, y: origin.y, z: origin.z, isCamera: false },
      { x: destination.x, y: destination.y, z: destination.z, isCamera: false },
    ],
    { halfExtents: multiFloorHalfExtents(floors), softenCorners: true },
  );

  if ('error' in discovery) {
    return { multiFloor: true, segments: [], connectors: [], legs: [], error: discovery.error };
  }
  if (discovery.path.length < 2) {
    return {
      multiFloor: true,
      segments: [],
      connectors: [],
      legs: [],
      error: 'No nav mesh path between floors',
    };
  }
  if (!discoveryTouchesFloor(discovery.path, destFloor.id, floors)) {
    return {
      multiFloor: true,
      segments: [],
      connectors: [],
      legs: [],
      error: `Stairs do not reach ${segmentLabel(destFloor)}`,
    };
  }

  let linkEndpoints = extractConnectorEndpoints(discovery.path, floors);
  if (linkEndpoints.length === 0) {
    linkEndpoints = [
      {
        fromFloorId: originFloor.id,
        toFloorId: destFloor.id,
        from: { x: origin.x, z: origin.z },
        to: { x: destination.x, z: destination.z },
      },
    ];
  }

  const connectors: FloorRouteConnector[] = [];
  for (const rawLink of linkEndpoints) {
    const fromFloor = floors.find((f) => f.id === rawLink.fromFloorId)!;
    const toFloor = floors.find((f) => f.id === rawLink.toFloorId)!;

    const mouthLink = resolveStairMouthLink(
      discovery.path,
      navMesh,
      map,
      floors,
      fromFloor,
      toFloor,
      origin,
      destination,
      activeWalk,
      activeFloorId,
    );
    if ('error' in mouthLink) {
      return { multiFloor: true, segments: [], connectors: [], legs: [], error: mouthLink.error };
    }

    const stair = computeStairNavPath(navMesh, floors, mouthLink);
    if ('error' in stair) {
      return { multiFloor: true, segments: [], connectors: [], legs: [], error: stair.error };
    }
    if (!stairNavHasSlope(stair, fromFloor, toFloor)) {
      return {
        multiFloor: true,
        segments: [],
        connectors: [],
        legs: [],
        error: `Stairs from ${segmentLabel(fromFloor)} need a horizontal run — route via the stair mouth, not straight down`,
      };
    }

    const snappedFrom = snapLandingToWalk(
      map,
      fromFloor,
      floors,
      mouthLink.from.x,
      mouthLink.from.z,
      activeWalk,
      activeFloorId,
    );
    const snappedTo = snapLandingToWalk(
      map,
      toFloor,
      floors,
      mouthLink.to.x,
      mouthLink.to.z,
      activeWalk,
      activeFloorId,
    );
    connectors.push({
      ...stair,
      from: snappedFrom,
      to: snappedTo,
      via: mergeStairVia(discovery.path, stair.via, mouthLink, floors),
    });
  }

  const chain = buildFloorChain(floors, originFloor, destFloor, connectors);
  const legs = buildFloorLegs(chain, connectors, origin, destination);
  const segments: FloorRouteSegment[] = [];

  for (const leg of legs) {
    const gridOut = routeOnFloorGrid(
      map,
      leg.floor,
      floors,
      leg.startX,
      leg.startZ,
      leg.endX,
      leg.endZ,
      activeWalk,
      activeFloorId,
    );
    if ('error' in gridOut) {
      return { multiFloor: true, segments, connectors, legs, error: `${segmentLabel(leg.floor)}: ${gridOut.error}` };
    }
    if (gridOut.path.length < 2) continue;
    segments.push({
      floorId: leg.floor.id,
      floorY: leg.floor.floorY,
      label: segmentLabel(leg.floor),
      path: gridOut.path,
    });
  }

  if (!segments.some((s) => s.path.length >= 2)) {
    return {
      multiFloor: true,
      segments: [],
      connectors,
      legs,
      error: 'No walkable path on floor — paint corridors on each level',
    };
  }

  return { multiFloor: connectors.length > 0, segments, connectors, legs };
}

function mergeFloorLeg(
  map: Floor2DMap,
  floors: FloorLevel[],
  leg: FloorLeg,
  revLeg: FloorLeg | undefined,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
  breaks: RouteBreakPoint[],
): FloorRouteSegment | null {
  const { floor, startX, startZ, endX, endZ } = leg;

  const fwd = routeOnFloorGrid(map, floor, floors, startX, startZ, endX, endZ, activeWalk, activeFloorId);
  const rev = routeOnFloorGrid(map, floor, floors, endX, endZ, startX, startZ, activeWalk, activeFloorId);

  if (revLeg && distXZ({ x: leg.startX, z: leg.startZ }, { x: revLeg.endX, z: revLeg.endZ }) > LANDING_MISMATCH) {
    breaks.push({
      floorId: floor.id,
      floorY: floor.floorY,
      x: (leg.startX + revLeg.endX) * 0.5,
      z: (leg.startZ + revLeg.endZ) * 0.5,
      label: 'O→D / D→O stair mouth mismatch',
    });
  }

  if (!('error' in fwd) && fwd.path.length >= 2) {
    if ('error' in rev) {
      breaks.push({
        floorId: floor.id,
        floorY: floor.floorY,
        x: endX,
        z: endZ,
        label: 'D→O failed here (O→D ok)',
      });
    }
    return {
      floorId: floor.id,
      floorY: floor.floorY,
      label: segmentLabel(floor),
      path: fwd.path,
    };
  }

  if (!('error' in rev) && rev.path.length >= 2) {
    breaks.push({
      floorId: floor.id,
      floorY: floor.floorY,
      x: startX,
      z: startZ,
      label: 'O→D failed — used D→O path',
    });
    return {
      floorId: floor.id,
      floorY: floor.floorY,
      label: segmentLabel(floor),
      path: reversePath(rev.path),
    };
  }

  const bridge = routeOnFloorGrid(map, floor, floors, startX, startZ, endX, endZ, activeWalk, activeFloorId);
  if (!('error' in bridge) && bridge.path.length >= 2) {
    breaks.push({
      floorId: floor.id,
      floorY: floor.floorY,
      x: (startX + endX) * 0.5,
      z: (startZ + endZ) * 0.5,
      label: 'Bridged O→D and D→O gap',
    });
    return {
      floorId: floor.id,
      floorY: floor.floorY,
      label: segmentLabel(floor),
      path: bridge.path,
    };
  }

  breaks.push({
    floorId: floor.id,
    floorY: floor.floorY,
    x: startX,
    z: startZ,
    label: 'error' in fwd ? fwd.error : 'No floor path both ways',
  });
  return null;
}

function mergeBidirectionalPlans(
  map: Floor2DMap,
  floors: FloorLevel[],
  forward: OneWayPlan,
  reverse: OneWayPlan,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): MultiFloorRoutePlan {
  const breaks: RouteBreakPoint[] = [];
  const debugForward = forward.segments;
  const debugReverse = reverse.segments.map((s) => ({
    ...s,
    path: reversePath(s.path),
  }));

  if (forward.error && reverse.error && forward.segments.length === 0 && reverse.segments.length === 0) {
    return {
      multiFloor: forward.multiFloor || reverse.multiFloor,
      segments: [],
      connectors: forward.connectors.length ? forward.connectors : reverse.connectors,
      error: `O→D: ${forward.error} · D→O: ${reverse.error}`,
      debugForward,
      debugReverse,
      breakPoints: breaks,
    };
  }

  const connectors = forward.connectors.length > 0 ? forward.connectors : reverse.connectors;
  const legs = forward.legs.length > 0 ? forward.legs : reverse.legs;
  const revLegByFloor = new Map(reverse.legs.map((l) => [l.floor.id, l]));
  const segments: FloorRouteSegment[] = [];

  for (const leg of legs) {
    const seg = mergeFloorLeg(
      map,
      floors,
      leg,
      revLegByFloor.get(leg.floor.id),
      activeWalk,
      activeFloorId,
      breaks,
    );
    if (seg) {
      segments.push(seg);
      continue;
    }
    const fallback =
      forward.segments.find((s) => s.floorId === leg.floor.id) ??
      reverse.segments.find((s) => s.floorId === leg.floor.id);
    if (fallback && fallback.path.length >= 2) {
      breaks.push({
        floorId: leg.floor.id,
        floorY: leg.floor.floorY,
        x: (leg.startX + leg.endX) * 0.5,
        z: (leg.startZ + leg.endZ) * 0.5,
        label: 'Used one-way floor path after merge failed',
      });
      segments.push(fallback);
    }
  }

  for (const link of connectors) {
    const revLink = reverse.connectors.find(
      (c) => c.fromFloorId === link.toFloorId && c.toFloorId === link.fromFloorId,
    );
    if (!revLink) continue;
    if (distXZ(link.from, revLink.to) > LANDING_MISMATCH) {
      const fromFloor = floors.find((f) => f.id === link.fromFloorId);
      if (fromFloor) {
        breaks.push({
          floorId: fromFloor.id,
          floorY: fromFloor.floorY,
          x: (link.from.x + revLink.to.x) * 0.5,
          z: (link.from.z + revLink.to.z) * 0.5,
          label: 'Lower stair mouth mismatch',
        });
      }
    }
    if (distXZ(link.to, revLink.from) > LANDING_MISMATCH) {
      const toFloor = floors.find((f) => f.id === link.toFloorId);
      if (toFloor) {
        breaks.push({
          floorId: toFloor.id,
          floorY: toFloor.floorY,
          x: (link.to.x + revLink.from.x) * 0.5,
          z: (link.to.z + revLink.from.z) * 0.5,
          label: 'Upper stair mouth mismatch',
        });
      }
    }
  }

  if (!segments.some((s) => s.path.length >= 2)) {
    return {
      multiFloor: connectors.length > 0,
      segments: [],
      connectors,
      error: forward.error ?? reverse.error ?? 'No merged floor path',
      debugForward,
      debugReverse,
      breakPoints: breaks,
    };
  }

  return {
    multiFloor: connectors.length > 0,
    segments,
    connectors,
    error: breaks.length > 0 ? `${breaks.length} route break(s) — see red markers` : undefined,
    debugForward,
    debugReverse,
    breakPoints: breaks,
  };
}

export function previewMapForFloor(
  map: Floor2DMap,
  floor: FloorLevel,
  allFloors: FloorLevel[],
): Floor2DMap {
  const walk = getFloorWalkGrid(map, floor);
  if (!walk) return map;
  return applyWalkGridEdits(map, walk, floor.objects ?? [], floor.zones ?? [], allFloors);
}

/**
 * Hybrid routing with bidirectional probes:
 * - Builds O→D and D→O separately (floor grid on plates, nav mesh on stairs).
 * - Merges per floor; bridges gaps where one direction fails.
 * - Returns debug paths + red break markers on the map.
 */
export function computeMultiFloorRoute(
  map: Floor2DMap,
  floors: FloorLevel[],
  navMesh: NavMesh | null,
  origin: { x: number; y: number; z: number },
  destination: { x: number; y: number; z: number },
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
  activeObjects: FloorBlock[],
): MultiFloorRoutePlan {
  const forward = buildOneWayHybridPlan(
    map,
    floors,
    navMesh,
    origin,
    destination,
    activeWalk,
    activeFloorId,
    activeObjects,
  );
  const reverse = buildOneWayHybridPlan(
    map,
    floors,
    navMesh,
    destination,
    origin,
    activeWalk,
    activeFloorId,
    activeObjects,
  );

  return mergeBidirectionalPlans(map, floors, forward, reverse, activeWalk, activeFloorId);
}
