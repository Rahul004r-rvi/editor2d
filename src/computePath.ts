import { NavMeshQuery } from 'recast-navigation';
import {
  NAV_MESH_FLOOR_QUERY_HALF_EXTENTS_Y,
  NAV_MESH_QUERY_HALF_EXTENTS,
} from './config';

/** Detour: add a vertex at every polygon edge crossing (denser corridor-following path). */
const DT_STRAIGHTPATH_ALL_CROSSINGS = 2;

export type NavPathPoint = { x: number; y: number; z: number };

export type ComputePathResult =
  | { success: true; path: NavPathPoint[] }
  | { success: false; error?: { name: string; status?: number } };

export type ComputePathOptions = {
  halfExtents?: { x: number; y: number; z: number };
  /** When set, tightens vertical search around this floor height (2D maps). */
  floorSliceY?: number;
};

function resolveHalfExtents(options?: ComputePathOptions): { x: number; y: number; z: number } {
  if (options?.halfExtents) return options.halfExtents;
  if (options?.floorSliceY !== undefined) {
    return {
      x: NAV_MESH_QUERY_HALF_EXTENTS.x,
      y: NAV_MESH_FLOOR_QUERY_HALF_EXTENTS_Y,
      z: NAV_MESH_QUERY_HALF_EXTENTS.z,
    };
  }
  return NAV_MESH_QUERY_HALF_EXTENTS;
}

/**
 * Mattercraft {@link NavigationRoute} helper — snap + corridor + straight path with all
 * edge crossings. Always pass `halfExtents` (or `floorSliceY`); check `success`, not `status`.
 */
export function computePath(
  navQuery: NavMeshQuery,
  start: NavPathPoint,
  end: NavPathPoint,
  options?: ComputePathOptions,
): ComputePathResult {
  const halfExtents = resolveHalfExtents(options);

  const startNear = navQuery.findNearestPoly(start, { halfExtents });
  if (!startNear.success || !startNear.nearestRef) {
    return {
      success: false,
      error: { name: 'findNearestPoly for start position failed', status: startNear.status },
    };
  }

  const endNear = navQuery.findNearestPoly(end, { halfExtents });
  if (!endNear.success || !endNear.nearestRef) {
    return {
      success: false,
      error: { name: 'findNearestPoly for end position failed', status: endNear.status },
    };
  }

  const startPos = startNear.nearestPoint;
  const endPos = endNear.nearestPoint;

  const corridor = navQuery.findPath(
    startNear.nearestRef,
    endNear.nearestRef,
    startPos,
    endPos,
    { maxPathPolys: 256 },
  );

  if (!corridor.success || corridor.polys.size <= 0) {
    corridor.polys.destroy();
    return {
      success: false,
      error: { name: 'findPath unsuccessful', status: corridor.status },
    };
  }

  let endOnPath = endPos;
  const lastPoly = corridor.polys.get(corridor.polys.size - 1);
  if (lastPoly !== endNear.nearestRef) {
    const onPoly = navQuery.closestPointOnPoly(lastPoly, end);
    if (!onPoly.success) {
      corridor.polys.destroy();
      return {
        success: false,
        error: { name: 'no closest point on last polygon found', status: onPoly.status },
      };
    }
    endOnPath = onPoly.closestPoint;
  }

  const straight = navQuery.findStraightPath(startPos, endOnPath, corridor.polys, {
    maxStraightPathPoints: 256,
    straightPathOptions: DT_STRAIGHTPATH_ALL_CROSSINGS,
  });
  corridor.polys.destroy();

  if (!straight.success || straight.straightPathCount < 2) {
    straight.straightPath.destroy();
    straight.straightPathFlags.destroy();
    straight.straightPathRefs.destroy();
    return {
      success: false,
      error: { name: 'findStraightPath unsuccessful', status: straight.status },
    };
  }

  const path: NavPathPoint[] = [];
  for (let i = 0; i < straight.straightPathCount; i++) {
    path.push({
      x: straight.straightPath.get(3 * i),
      y: straight.straightPath.get(3 * i + 1),
      z: straight.straightPath.get(3 * i + 2),
    });
  }

  straight.straightPath.destroy();
  straight.straightPathFlags.destroy();
  straight.straightPathRefs.destroy();

  return { success: true, path };
}
