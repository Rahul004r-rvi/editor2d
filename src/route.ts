import * as THREE from 'three';
import type { NavMesh } from 'recast-navigation';
import { computeNavigationRoutePath } from './navmeshSnap';

const PATH_COLOR = 0x2563eb;
const PATH_TUBE_RADIUS = 0.15;
const PATH_LINE_LIFT_Y = 0.08;
const CRUMB_GAP = 0.09;
const CRUMB_RADIUS = 0.12;
const CRUMB_OUTLINE_RADIUS = 0.155;
const CRUMB_HEIGHT = 0.07;
const CRUMB_BASE_COLOR = 0x6b0000;
const CRUMB_OUTLINE_COLOR = 0x1a0505;
const CRUMB_SHADOW_COLOR = 0x000000;
const MAX_CRUMBS = 500;
const ORIGIN_COLOR = 0x00ff88;
const DEST_COLOR = 0xff3366;
const _crumbMatrix = new THREE.Matrix4();
const _crumbRotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

function createMarker(color: number, radius = 0.28): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: true, transparent: true, opacity: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  return mesh;
}

function computeNavPath(
  navMesh: NavMesh | null,
  startVec: THREE.Vector3,
  endVec: THREE.Vector3,
  floorSliceY?: number,
): { path: THREE.Vector3[]; error: null } | { path: null; error: string } {
  const out = computeNavigationRoutePath(
    navMesh,
    [
      { x: startVec.x, y: startVec.y, z: startVec.z },
      { x: endVec.x, y: endVec.y, z: endVec.z },
    ],
    { floorSliceY },
  );
  if ('error' in out) return { path: null, error: out.error };
  return {
    path: out.path.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
    error: null,
  };
}

function liftPathPoints(pathPoints: THREE.Vector3[], liftY: number): THREE.Vector3[] {
  return pathPoints.map((p) => new THREE.Vector3(p.x, p.y + liftY, p.z));
}

function disposePathMesh(obj: THREE.Object3D): void {
  let sharedMat: THREE.Material | null = null;
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const m = child.material;
      if (!sharedMat && m && !Array.isArray(m)) sharedMat = m;
    }
  });
  sharedMat?.dispose();
}

function createPathMesh(pathPoints: THREE.Vector3[]): THREE.Group | null {
  if (!pathPoints || pathPoints.length < 2) return null;
  const group = new THREE.Group();
  group.name = 'NavPathLine';
  group.frustumCulled = false;
  const mat = new THREE.MeshBasicMaterial({ color: PATH_COLOR });
  const lifted = liftPathPoints(pathPoints, PATH_LINE_LIFT_Y);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < lifted.length - 1; i++) {
    const a = lifted[i];
    const b = lifted[i + 1];
    const delta = b.clone().sub(a);
    const len = delta.length();
    if (len < 1e-5) continue;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, delta.clone().normalize());
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(PATH_TUBE_RADIUS, PATH_TUBE_RADIUS, len, 10),
      mat,
    );
    seg.position.copy(mid);
    seg.quaternion.copy(quat);
    seg.renderOrder = 4;
    group.add(seg);
  }
  return group.children.length > 0 ? group : null;
}

function createBreadcrumbInstanced() {
  const baseMat = new THREE.MeshBasicMaterial({
    color: CRUMB_BASE_COLOR,
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  const outlineMat = new THREE.MeshBasicMaterial({
    color: CRUMB_OUTLINE_COLOR,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const shadowMat = new THREE.MeshBasicMaterial({
    color: CRUMB_SHADOW_COLOR,
    opacity: 0.65,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const baseGeo = new THREE.CircleGeometry(CRUMB_RADIUS, 16);
  const outlineGeo = new THREE.CircleGeometry(CRUMB_OUTLINE_RADIUS, 16);
  const baseMesh = new THREE.InstancedMesh(baseGeo, baseMat, MAX_CRUMBS);
  const outlineMesh = new THREE.InstancedMesh(outlineGeo, outlineMat, MAX_CRUMBS);
  const shadowMesh = new THREE.InstancedMesh(outlineGeo, shadowMat, MAX_CRUMBS);
  baseMesh.count = 0;
  outlineMesh.count = 0;
  shadowMesh.count = 0;
  baseMesh.frustumCulled = false;
  outlineMesh.frustumCulled = false;
  shadowMesh.frustumCulled = false;
  shadowMesh.renderOrder = 5;
  outlineMesh.renderOrder = 6;
  baseMesh.renderOrder = 7;
  outlineMesh.position.set(0, CRUMB_HEIGHT, 0);
  baseMesh.position.set(0, CRUMB_HEIGHT + 0.004, 0);
  shadowMesh.position.set(0, CRUMB_HEIGHT - 0.006, 0);
  return { baseMesh, outlineMesh, shadowMesh, baseGeo, outlineGeo, baseMat, outlineMat, shadowMat };
}

function updateBreadcrumbsAlongPath(mesh: THREE.InstancedMesh, pathPoints: THREE.Vector3[], gap: number) {
  if (!pathPoints || pathPoints.length < 2) {
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.visible = false;
    return;
  }
  const curve = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 0; i < pathPoints.length - 1; i++) {
    curve.add(new THREE.LineCurve3(pathPoints[i], pathPoints[i + 1]));
  }
  const length = curve.getLength();
  if (length < 0.001) {
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.visible = false;
    return;
  }
  let totalPoints = Math.min(Math.floor(length / gap) + 1, MAX_CRUMBS);
  const offsetAtStart = totalPoints > 1 ? (length - (totalPoints - 1) * gap) / length : 0;
  const pt = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const target = new THREE.Vector3();
  mesh.count = totalPoints;
  for (let i = 0; i < totalPoints; i++) {
    const u = totalPoints > 1 ? Math.min(offsetAtStart + (i * gap) / length, 1) : 0;
    curve.getPointAt(u, pt);
    pt.y += PATH_LINE_LIFT_Y + CRUMB_HEIGHT;
    curve.getTangentAt(u, tangent);
    _crumbMatrix.identity();
    _crumbMatrix.setPosition(pt);
    target.copy(pt).add(tangent);
    _crumbMatrix.lookAt(pt, target, new THREE.Vector3(0, 1, 0));
    _crumbMatrix.multiply(_crumbRotation);
    mesh.setMatrixAt(i, _crumbMatrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.visible = true;
}

export function defaultDestinationOnMap(mapRoot: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(mapRoot);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  if (box.isEmpty()) return new THREE.Vector3(0, 0, 3);
  box.getCenter(center);
  box.getSize(size);
  const span = Math.max(size.x, size.z, 1);
  return new THREE.Vector3(center.x + span * 0.22, center.y, center.z + span * 0.18);
}

export interface RouteBreadcrumbsOptions {
  getOrigin?: () => THREE.Vector3;
  hideSphereMarkers?: boolean;
  hideBreadcrumbs?: boolean;
  /** Tighten nav snap/path to one floor (2D map). */
  floorSliceY?: number;
}

export interface RouteAndBreadcrumbsHandle {
  group: THREE.Group;
  destination: THREE.Vector3;
  origin: THREE.Vector3;
  readonly state: { pathPoints: THREE.Vector3[]; valid: boolean; error: string | null };
  setOrigin(x: number, y: number, z: number): void;
  setDestination(x: number, y: number, z: number): void;
  rebuild(): void;
  dispose(): void;
}

export function createRouteAndBreadcrumbs(
  getNavMeshFn: () => NavMesh | null,
  options: RouteBreadcrumbsOptions = {},
): RouteAndBreadcrumbsHandle {
  const group = new THREE.Group();
  group.name = 'NavRouteAndCrumbs';
  const origin = new THREE.Vector3(0, 0, 0);
  const getOrigin = options.getOrigin ?? (() => origin);
  const hideSpheres = options.hideSphereMarkers === true;
  const hideCrumbs = options.hideBreadcrumbs === true;
  const originMarker = createMarker(ORIGIN_COLOR, 0.32);
  const destMarker = createMarker(DEST_COLOR, 0.32);
  originMarker.visible = !hideSpheres;
  destMarker.visible = !hideSpheres;
  group.add(originMarker, destMarker);
  let routeLine: THREE.Group | null = null;
  const destination = new THREE.Vector3(0, 0, 3);
  const state = { pathPoints: [] as THREE.Vector3[], valid: false, error: null as string | null };
  const crumbs = createBreadcrumbInstanced();
  const crumbGroup = new THREE.Group();
  crumbGroup.name = 'Breadcrumbs';
  crumbGroup.add(crumbs.baseMesh, crumbs.outlineMesh, crumbs.shadowMesh);
  crumbGroup.visible = !hideCrumbs;
  group.add(crumbGroup);

  function rebuildLine() {
    if (routeLine) {
      group.remove(routeLine);
      disposePathMesh(routeLine);
      routeLine = null;
    }
    const originPt = options.getOrigin ? getOrigin().clone() : origin.clone();
    if (!options.getOrigin) origin.copy(originPt);
    originMarker.position.copy(originPt);
    destMarker.position.copy(destination);
    const navOut = computeNavPath(getNavMeshFn(), originPt, destination, options.floorSliceY);
    if (!navOut.path || navOut.path.length < 2) {
      state.valid = false;
      state.error = navOut.error ?? 'No path';
      state.pathPoints = [];
      if (!hideCrumbs) {
        updateBreadcrumbsAlongPath(crumbs.baseMesh, [], CRUMB_GAP);
        updateBreadcrumbsAlongPath(crumbs.outlineMesh, [], CRUMB_GAP);
        updateBreadcrumbsAlongPath(crumbs.shadowMesh, [], CRUMB_GAP);
      }
      return;
    }
    const pathPts = navOut.path;
    state.pathPoints = pathPts;
    state.valid = true;
    state.error = null;
    routeLine = createPathMesh(pathPts);
    if (routeLine) group.add(routeLine);
    if (!hideCrumbs) {
      updateBreadcrumbsAlongPath(crumbs.baseMesh, pathPts, CRUMB_GAP);
      updateBreadcrumbsAlongPath(crumbs.outlineMesh, pathPts, CRUMB_GAP);
      updateBreadcrumbsAlongPath(crumbs.shadowMesh, pathPts, CRUMB_GAP);
    }
  }

  function dispose() {
    if (routeLine) disposePathMesh(routeLine);
    crumbs.baseGeo.dispose();
    crumbs.outlineGeo.dispose();
    crumbs.baseMat.dispose();
    crumbs.outlineMat.dispose();
    crumbs.shadowMat.dispose();
    originMarker.geometry.dispose();
    (originMarker.material as THREE.Material).dispose();
    destMarker.geometry.dispose();
    (destMarker.material as THREE.Material).dispose();
  }

  return {
    group,
    destination,
    origin,
    get state() {
      return state;
    },
    setOrigin(x, y, z) {
      origin.set(x, y, z);
      if (options.getOrigin) options.getOrigin().set(x, y, z);
      originMarker.position.copy(origin);
      rebuildLine();
    },
    setDestination(x, y, z) {
      destination.set(x, y, z);
      destMarker.position.copy(destination);
      rebuildLine();
    },
    rebuild: rebuildLine,
    dispose,
  };
}
