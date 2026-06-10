import * as THREE from 'three';
import { NavMeshQuery } from 'recast-navigation';
import type { NavMesh } from 'recast-navigation';
import { computePath } from './computePath';
import {
  NAV_MESH_FLOOR_QUERY_HALF_EXTENTS_Y,
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

export type NavPathQueryOptions = {
  softenCorners?: boolean;
  cameraPositionOffsetY?: number;
  /** Tighten vertical snap when routing on a 2D floor slice. */
  floorSliceY?: number;
  halfExtents?: { x: number; y: number; z: number };
};

export function getNavQueryHalfExtents(floorSliceY?: number): { x: number; y: number; z: number } {
  if (floorSliceY === undefined) return NAV_MESH_QUERY_HALF_EXTENTS;
  return {
    x: NAV_MESH_QUERY_HALF_EXTENTS.x,
    y: NAV_MESH_FLOOR_QUERY_HALF_EXTENTS_Y,
    z: NAV_MESH_QUERY_HALF_EXTENTS.z,
  };
}

/**
 * Snap a world point onto the walkable mesh (customizeroute behavior):
 * tall enough vertical search for floor height + Y offset for non-camera markers.
 */
export function snapPointToNavMesh(
  navQuery: NavMeshQuery,
  x: number,
  y: number,
  z: number,
  isCamera = false,
  cameraPositionOffsetY = ROUTE_CAMERA_POSITION_OFFSET_Y,
  halfExtents = NAV_MESH_QUERY_HALF_EXTENTS,
): Vec3 | null {
  const sampleY = isCamera ? y : y + cameraPositionOffsetY;
  const result = navQuery.findNearestPoly(
    { x, y: sampleY, z },
    { halfExtents },
  );
  if (!result.success || !result.nearestRef) return null;
  return result.nearestPoint;
}

function segmentOnNavMesh(
  navQuery: NavMeshQuery,
  fromRef: number,
  from: THREE.Vector3,
  to: THREE.Vector3,
): boolean {
  const ray = navQuery.raycast(fromRef, from, to);
  if (!ray.success) return false;
  return ray.t >= 0.99;
}

function softenPathCorners(
  navQuery: NavMeshQuery,
  points: THREE.Vector3[],
  polyRefs: number[],
  softenDist = ROUTE_CORNER_SOFTEN_DIST,
): THREE.Vector3[] {
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
    const p1 = new THREE.Vector3().copy(cur).addScaledVector(toPrev, cut);
    const p2 = new THREE.Vector3().copy(cur).addScaledVector(toNext, cut);

    const fromRef = polyRefs[i] ?? polyRefs[i - 1];
    if (fromRef && segmentOnNavMesh(navQuery, fromRef, p1, p2)) {
      out.push(p1, p2);
    } else {
      out.push(cur.clone());
    }
  }

  out.push(points[points.length - 1].clone());
  return out;
}

function snapPolyRefsForPath(navQuery: NavMeshQuery, path: Vec3[], halfExtents: Vec3): number[] {
  const refs: number[] = [];
  for (const p of path) {
    const near = navQuery.findNearestPoly(p, { halfExtents });
    refs.push(near.nearestRef ?? 0);
  }
  return refs;
}

/**
 * Build a dense nav-mesh route through waypoints (origin → … → destination).
 */
export function computeNavigationRoutePath(
  navMesh: NavMesh | null,
  waypoints: RouteWaypoint[],
  options: NavPathQueryOptions = {},
): { path: Vec3[] } | { error: string } {
  if (!navMesh) return { error: 'Nav mesh not built yet' };
  if (waypoints.length < 2) return { error: 'Route needs at least two points' };

  const softenCorners = options.softenCorners !== false;
  const offsetY = options.cameraPositionOffsetY ?? ROUTE_CAMERA_POSITION_OFFSET_Y;
  const halfExtents =
    options.halfExtents ?? getNavQueryHalfExtents(options.floorSliceY);
  const navQuery = new NavMeshQuery(navMesh);
  const densePoints: THREE.Vector3[] = [];
  let error: string | undefined;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const start = snapPointToNavMesh(
      navQuery,
      a.x,
      a.y,
      a.z,
      a.isCamera === true,
      offsetY,
      halfExtents,
    );
    const end = snapPointToNavMesh(
      navQuery,
      b.x,
      b.y,
      b.z,
      b.isCamera === true,
      offsetY,
      halfExtents,
    );

    if (!start || !end) {
      error = `Unable to find path between point ${i} and point ${i + 1}`;
      break;
    }

    const pathResult = computePath(navQuery, start, end, {
      halfExtents,
      floorSliceY: options.floorSliceY,
    });

    if (!pathResult.success || !pathResult.path || pathResult.path.length < 2) {
      error =
        pathResult.success === false
          ? pathResult.error?.name ?? `Unable to find path between point ${i} and point ${i + 1}`
          : `Unable to find path between point ${i} and point ${i + 1}`;
      break;
    }

    for (const entry of pathResult.path) {
      densePoints.push(new THREE.Vector3(entry.x, entry.y, entry.z));
    }
  }

  if (densePoints.length < 2) {
    return { error: error ?? 'No route on nav mesh' };
  }

  if (!softenCorners) {
    return { path: densePoints.map((p) => ({ x: p.x, y: p.y, z: p.z })) };
  }

  const polyRefs = snapPolyRefsForPath(navQuery, densePoints, halfExtents);
  const finalPoints = softenPathCorners(navQuery, densePoints, polyRefs);
  return {
    path: finalPoints.map((p) => ({ x: p.x, y: p.y, z: p.z })),
  };
}

/** Origin → destination (POI markers are non-camera). */
export function computeSnappedNavPath(
  navMesh: NavMesh | null,
  start: Vec3,
  end: Vec3,
  options: Pick<NavPathQueryOptions, 'floorSliceY' | 'halfExtents'> = {},
): { path: Vec3[] } | { error: string } {
  return computeNavigationRoutePath(navMesh, [
    { x: start.x, y: start.y, z: start.z, isCamera: false },
    { x: end.x, y: end.y, z: end.z, isCamera: false },
  ], options);
}
