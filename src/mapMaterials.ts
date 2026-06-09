import * as THREE from 'three';
import { MAP_GHOST_OPACITY } from './config';

type MapRootUserData = { mapGhostMaterial?: THREE.MeshStandardMaterial };

function applyTransparentOpacityToMaterial(mat: THREE.Material): THREE.Material {
  const m = mat.clone();
  m.transparent = true;
  m.opacity = MAP_GHOST_OPACITY;
  m.depthWrite = false;
  if ('side' in m) (m as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  return m;
}

function disposeMapMeshMaterials(mesh: THREE.Mesh, sharedGhost: THREE.Material | undefined): void {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    if (!mat || mat === sharedGhost) continue;
    mat.dispose();
  }
}

export function disposeMapChildren(mapRoot: THREE.Group): void {
  const rootUd = mapRoot.userData as MapRootUserData;
  const sharedGhost = rootUd.mapGhostMaterial;
  mapRoot.traverse((o) => {
    if (o instanceof THREE.LineSegments || o instanceof THREE.Line) {
      o.geometry?.dispose();
      const m = o.material;
      if (Array.isArray(m)) {
        for (const mat of m) if (mat && mat !== sharedGhost) mat.dispose();
      } else if (m && m !== sharedGhost) (m as THREE.Material).dispose();
      return;
    }
    if (o instanceof THREE.Mesh) {
      o.geometry?.dispose();
      disposeMapMeshMaterials(o, sharedGhost);
    }
  });
  sharedGhost?.dispose();
  rootUd.mapGhostMaterial = undefined;
  while (mapRoot.children.length) mapRoot.remove(mapRoot.children[0]);
}

export function applyMapTransparentGhostMaterial(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (
      !(o instanceof THREE.Mesh) ||
      !o.geometry ||
      (o.userData as { skipMapGhostMaterial?: boolean }).skipMapGhostMaterial
    ) {
      return;
    }
    if (Array.isArray(o.material)) {
      const oldMats = o.material;
      o.material = oldMats.map((mat) => applyTransparentOpacityToMaterial(mat));
      for (const mat of oldMats) mat.dispose();
    } else {
      const oldMat = o.material;
      o.material = applyTransparentOpacityToMaterial(oldMat);
      oldMat.dispose();
    }
    o.visible = true;
  });
}
