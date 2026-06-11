import type { NavMesh } from 'recast-navigation';
import type { Floor2DMap, FloorBlock, FloorLevel } from './floor2d';
import { applyWalkGridEdits } from './floor2d';
import { findPathOnFloorGrid, snapWorldToWalkCell, type FloorPathPoint } from './floor2dRoute';
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

function stairViaPoints(path: Vec3[], fromFloor: FloorLevel, toFloor: FloorLevel): Vec3[] {
  if (path.length < 2) return path;
  const low = Math.min(fromFloor.floorY, toFloor.floorY);
  const high = Math.max(fromFloor.floorY, toFloor.floorY);
  if (high - low < STAIR_Y_MARGIN * 2) return path.slice(1, -1);

  const onSlope = path.filter((p) => p.y > low + STAIR_Y_MARGIN && p.y < high - STAIR_Y_MARGIN);
  return onSlope.length >= 2 ? onSlope : path.slice(1, -1);
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
  for (const link of linkEndpoints) {
    const stair = computeStairNavPath(navMesh, floors, link);
    if ('error' in stair) {
      return { multiFloor: true, segments: [], connectors: [], legs: [], error: stair.error };
    }
    const fromFloor = floors.find((f) => f.id === stair.fromFloorId)!;
    const toFloor = floors.find((f) => f.id === stair.toFloorId)!;
    connectors.push({
      ...stair,
      from: snapLandingToWalk(map, fromFloor, floors, stair.from.x, stair.from.z, activeWalk, activeFloorId),
      to: snapLandingToWalk(map, toFloor, floors, stair.to.x, stair.to.z, activeWalk, activeFloorId),
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
    if (seg) segments.push(seg);
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
