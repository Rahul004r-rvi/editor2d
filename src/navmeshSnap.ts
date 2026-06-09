import * as THREE from 'three';
import { NavMeshQuery } from 'recast-navigation';
import type { NavMesh } from 'recast-navigation';
import {
  NAV_MESH_QUERY_HALF_EXTENTS,
  ROUTE_CAMERA_POSITION_OFFSET_Y,
  ROUTE_CORNER_SOFTEN_DIST,
} from './config';

type Vec3 = { x: number; y: number; z: number };

export type RouteWaypoint = {
  x: number;
  y: number;
  z: number;
  /** When true, snap at exact Y (camera). Otherwise Y + offset used for sampling. */
  isCamera?: boolean;
};

/**
 * Snap a world point onto the walkable mesh (customizeroute behavior):
 * tall vertical search + Y offset for non-camera markers.
 */
export function snapPointToNavMesh(
  navQuery: NavMeshQuery,
  x: number,
  y: number,
  z: number,
  isCamera = false,
  cameraPositionOffsetY = ROUTE_CAMERA_POSITION_OFFSET_Y,
): Vec3 | null {
  const sampleY = isCamera ? y : y + cameraPositionOffsetY;
  const result = navQuery.findClosestPoint(
    { x, y: sampleY, z },
    { halfExtents: NAV_MESH_QUERY_HALF_EXTENTS },
  );
  if (!result.success || !result.point) return null;
  return result.point;
}

function softenPathCorners(points: THREE.Vector3[], softenDist = ROUTE_CORNER_SOFTEN_DIST): THREE.Vector3[] {
  if (!points || points.length < 3) return points;

  const out: THREE.Vector3[] = [points[0].clone()];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];

    const toPrev = new THREE.Vector3().subVectors(prev, cur);
    const toNext = new THREE.Vector3().subVectors(next, cur);

    const lenPrev = toPrev.length();
    const lenNext = toNext.length();

    if (lenPrev < 0.0001 || lenNext < 0.0001) {
      out.push(cur.clone());
      continue;
    }

    toPrev.normalize();
    toNext.normalize();

    const cornerDot = THREE.MathUtils.clamp(toPrev.dot(toNext), -1, 1);
    const cornerAngle = Math.acos(cornerDot);

    if (cornerAngle > Math.PI * 0.86) {
      out.push(cur.clone());
      continue;
    }

    const cut = Math.min(softenDist, lenPrev * 0.34, lenNext * 0.34);

    out.push(
      new THREE.Vector3().copy(cur).addScaledVector(toPrev, cut),
      new THREE.Vector3().copy(cur).addScaledVector(toNext, cut),
    );
  }

  out.push(points[points.length - 1].clone());
  return out;
}

/**
 * Build a dense nav-mesh route through waypoints (origin → … → destination),
 * matching customizeroute snapping + computePath + corner softening.
 */
export function computeNavigationRoutePath(
  navMesh: NavMesh | null,
  waypoints: RouteWaypoint[],
  options: { softenCorners?: boolean; cameraPositionOffsetY?: number } = {},
): { path: Vec3[] } | { error: string } {
  if (!navMesh) return { error: 'Nav mesh not built yet' };
  if (waypoints.length < 2) return { error: 'Route needs at least two points' };

  const softenCorners = options.softenCorners !== false;
  const offsetY = options.cameraPositionOffsetY ?? ROUTE_CAMERA_POSITION_OFFSET_Y;
  const navQuery = new NavMeshQuery(navMesh);
  const densePoints: THREE.Vector3[] = [];
  let error: string | undefined;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const start = snapPointToNavMesh(navQuery, a.x, a.y, a.z, a.isCamera === true, offsetY);
    const end = snapPointToNavMesh(navQuery, b.x, b.y, b.z, b.isCamera === true, offsetY);

    if (!start || !end) {
      error = `Unable to find path between point ${i} and point ${i + 1}`;
      break;
    }

    const pathResult = navQuery.computePath(start, end, {
      halfExtents: NAV_MESH_QUERY_HALF_EXTENTS,
    });

    if (!pathResult.success || !pathResult.path || pathResult.path.length < 2) {
      error = `Unable to find path between point ${i} and point ${i + 1}`;
      break;
    }

    for (const entry of pathResult.path) {
      densePoints.push(new THREE.Vector3(entry.x, entry.y, entry.z));
    }
  }

  if (densePoints.length < 2) {
    return { error: error ?? 'No route on nav mesh' };
  }

  const finalPoints = softenCorners ? softenPathCorners(densePoints) : densePoints;
  return {
    path: finalPoints.map((p) => ({ x: p.x, y: p.y, z: p.z })),
  };
}

/** Origin → destination (POI markers are non-camera). */
export function computeSnappedNavPath(
  navMesh: NavMesh | null,
  start: Vec3,
  end: Vec3,
): { path: Vec3[] } | { error: string } {
  return computeNavigationRoutePath(navMesh, [
    { x: start.x, y: start.y, z: start.z, isCamera: false },
    { x: end.x, y: end.y, z: end.z, isCamera: false },
  ]);
}
