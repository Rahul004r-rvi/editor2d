import * as THREE from 'three';
import { forEachWorldTriangle } from './meshUtils';

/** Flat triangle list: [ax,ay,az, bx,by,bz, cx,cy,cz, ...] near horizontal floor slice. */
export function exportFloorSliceTriangles(
  mapRoot: THREE.Object3D,
  sliceY: number,
  band = 0.45,
): number[] {
  const out: number[] = [];
  forEachWorldTriangle(mapRoot, (a, b, c, n) => {
    if (n.y < 0.35) return;
    const yMin = Math.min(a.y, b.y, c.y);
    const yMax = Math.max(a.y, b.y, c.y);
    if (yMax < sliceY - band || yMin > sliceY + band) return;
    out.push(
      a.x, a.y, a.z,
      b.x, b.y, b.z,
      c.x, c.y, c.z,
    );
  });
  return out;
}
