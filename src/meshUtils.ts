import * as THREE from 'three';

const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();

export function forEachWorldTriangle(
  root: THREE.Object3D,
  fn: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, normal: THREE.Vector3) => void,
): void {
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.geometry?.attributes?.position) return;
    const geo = obj.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    _m.copy(obj.matrixWorld);
    const idx = geo.index;
    const emit = (ia: number, ib: number, ic: number) => {
      _va.fromBufferAttribute(pos, ia).applyMatrix4(_m);
      _vb.fromBufferAttribute(pos, ib).applyMatrix4(_m);
      _vc.fromBufferAttribute(pos, ic).applyMatrix4(_m);
      _ab.subVectors(_vb, _va);
      _ac.subVectors(_vc, _va);
      _n.crossVectors(_ab, _ac);
      if (_n.lengthSq() < 1e-12) return;
      _n.normalize();
      fn(_va, _vb, _vc, _n.clone());
    };
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        emit(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) emit(i, i + 1, i + 2);
    }
  });
}
