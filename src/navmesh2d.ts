import type { NavMesh } from 'recast-navigation';
import { NAV_MESH_AGENT_RADIUS } from './config';

export type NavMeshSliceTri = {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  cx: number;
  cz: number;
};

/** Project navmesh debug triangles onto the XZ plane near sliceY. */
export function extractNavMeshSlice2D(
  navMesh: NavMesh,
  sliceY: number,
  band = Math.max(0.5, NAV_MESH_AGENT_RADIUS * 4),
): NavMeshSliceTri[] {
  const [positions, indices] = navMesh.getDebugNavMesh();
  const tris: NavMeshSliceTri[] = [];

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;
    const ay = positions[ia + 1];
    const by = positions[ib + 1];
    const cy = positions[ic + 1];
    const yMin = Math.min(ay, by, cy);
    const yMax = Math.max(ay, by, cy);
    if (yMax < sliceY - band || yMin > sliceY + band) continue;

    tris.push({
      ax: positions[ia],
      az: positions[ia + 2],
      bx: positions[ib],
      bz: positions[ib + 2],
      cx: positions[ic],
      cz: positions[ic + 2],
    });
  }

  return tris;
}
