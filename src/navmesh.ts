import * as THREE from 'three';
import { init as recastInit } from 'recast-navigation';
import { generateSoloNavMesh } from '@recast-navigation/generators';
import type { NavMesh } from 'recast-navigation';
import {
  FALLBACK_FULL_NAV_MESH,
  FAST_NAV_MESH,
  NAV_MESH_AGENT_RADIUS,
  NAV_MESH_CELL_HEIGHT,
  NAV_MESH_CELL_SIZE,
  NAV_MESH_WALKABLE_CLIMB,
  NAV_MESH_WALKABLE_HEIGHT,
} from './config';

type RecastGenConfig = Record<string, number | string | boolean | undefined>;

let initPromise: Promise<void> | null = null;
let currentNavMesh: NavMesh | null = null;

/** WASM-safe cap — cs=0.02 on large malls exceeds linear memory. */
const MAX_NAV_GRID_CELLS = 1_500_000;

async function ensureRecastLoaded(): Promise<void> {
  if (!initPromise) initPromise = recastInit();
  await initPromise;
}

function gridCellsForBounds(bounds: ReturnType<typeof computeBounds>, cs: number): number {
  const maxHoriz = Math.max(bounds.sizeX, bounds.sizeZ, 0.1);
  const w = Math.ceil(maxHoriz / cs);
  const h = Math.ceil(maxHoriz / cs);
  return w * h;
}

/** Pick finest cell size that fits in memory (prefers 0.02 → 0.05 → 0.1 …). */
function pickNavCellSizes(bounds: ReturnType<typeof computeBounds>): number[] {
  const candidates = [
    NAV_MESH_AGENT_RADIUS,
    NAV_MESH_AGENT_RADIUS * 2.5,
    0.08,
    NAV_MESH_CELL_SIZE,
    0.15,
    0.2,
    0.3,
  ];
  const unique = [...new Set(candidates.map((c) => +c.toFixed(4)))];
  const safe = unique.filter((cs) => gridCellsForBounds(bounds, cs) <= MAX_NAV_GRID_CELLS);
  if (safe.length > 0) return safe;
  const maxHoriz = Math.max(bounds.sizeX, bounds.sizeZ, 0.1);
  return [maxHoriz / Math.sqrt(MAX_NAV_GRID_CELLS)];
}

/** Reference-style: walkableRadius / climb / height are in voxels (world ÷ cell). */
function buildNavConfig(cs: number, relaxed = false): RecastGenConfig {
  const ch = NAV_MESH_CELL_HEIGHT;
  return {
    cs,
    ch,
    walkableSlopeAngle: relaxed ? 75 : 60,
    walkableHeight: NAV_MESH_WALKABLE_HEIGHT / ch,
    walkableClimb: NAV_MESH_WALKABLE_CLIMB / ch,
    walkableRadius: NAV_MESH_AGENT_RADIUS / cs,
    borderSize: 0,
    minRegionArea: relaxed ? 1 : 2,
    mergeRegionArea: relaxed ? 2 : 8,
  };
}

function collectMeshes(root: THREE.Object3D | null): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  if (!root) return meshes;
  root.traverse((child) => {
    if (
      child instanceof THREE.Mesh &&
      child.geometry &&
      child.name !== 'NavMeshHelperMesh' &&
      !(child.userData as { skipNavMesh?: boolean }).skipNavMesh
    ) {
      meshes.push(child);
    }
  });
  return meshes.filter((m) => {
    const pos = m.geometry?.attributes?.position;
    if (!pos || pos.count < 3) return false;
    return pos instanceof THREE.BufferAttribute || pos instanceof THREE.InterleavedBufferAttribute;
  });
}

function extractWorldPositionsAndIndices(meshes: THREE.Mesh[]): [Float32Array, Uint32Array] {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const mesh of meshes) {
    if (!mesh.geometry?.attributes?.position) continue;
    const posAttr = mesh.geometry.attributes.position;
    totalVerts += posAttr.count;
    const idx = mesh.geometry.index;
    if (idx && idx.count >= 3) totalIndices += idx.count;
    else totalIndices += Math.floor(posAttr.count / 3) * 3;
  }
  const positions = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);
  let vOffset = 0;
  let iOffset = 0;
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  for (const mesh of meshes) {
    if (!mesh.geometry?.attributes?.position) continue;
    mesh.updateWorldMatrix(true, false);
    m.copy(mesh.matrixWorld);
    const flipWindingForThisMesh = m.determinant() < 0;
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(m);
      const p = (vOffset + i) * 3;
      positions[p] = v.x;
      positions[p + 1] = v.y;
      positions[p + 2] = v.z;
    }
    const idxAttr = geo.index;
    if (idxAttr && idxAttr.count >= 3) {
      if (!flipWindingForThisMesh) {
        for (let i = 0; i < idxAttr.count; i++) indices[iOffset + i] = vOffset + idxAttr.getX(i);
        iOffset += idxAttr.count;
      } else {
        const triCount = Math.floor(idxAttr.count / 3);
        for (let t = 0; t < triCount; t++) {
          indices[iOffset++] = vOffset + idxAttr.getX(t * 3 + 0);
          indices[iOffset++] = vOffset + idxAttr.getX(t * 3 + 2);
          indices[iOffset++] = vOffset + idxAttr.getX(t * 3 + 1);
        }
      }
    } else {
      const triCount = Math.floor(posAttr.count / 3);
      for (let t = 0; t < triCount; t++) {
        const a = t * 3;
        const b = t * 3 + 1;
        const c = t * 3 + 2;
        if (!flipWindingForThisMesh) {
          indices[iOffset++] = vOffset + a;
          indices[iOffset++] = vOffset + b;
          indices[iOffset++] = vOffset + c;
        } else {
          indices[iOffset++] = vOffset + a;
          indices[iOffset++] = vOffset + c;
          indices[iOffset++] = vOffset + b;
        }
      }
    }
    vOffset += posAttr.count;
  }
  if (iOffset !== indices.length) return [positions, indices.slice(0, iOffset)];
  return [positions, indices];
}

function computeBounds(positions: Float32Array, indices: Uint32Array) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const x = positions[idx * 3];
    const y = positions[idx * 3 + 1];
    const z = positions[idx * 3 + 2];
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return { min, max, sizeX: max[0] - min[0], sizeY: max[1] - min[1], sizeZ: max[2] - min[2] };
}

function remapPositions(positions: Float32Array, mode: string): Float32Array {
  if (mode === 'identity') return positions;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (mode === 'swapYZ') {
      out[i] = x;
      out[i + 1] = z;
      out[i + 2] = y;
    } else {
      out[i] = x;
      out[i + 1] = y;
      out[i + 2] = z;
    }
  }
  return out;
}

function remapIndices(indices: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) {
    out[i] = indices[i];
    out[i + 1] = indices[i + 2];
    out[i + 2] = indices[i + 1];
  }
  return out;
}

function tryGenerate(
  positions: Float32Array,
  indices: Uint32Array,
  config: RecastGenConfig,
): { result: { success: boolean; navMesh?: NavMesh; error?: string }; durationMs: number } {
  const t0 = performance.now();
  try {
    const result = generateSoloNavMesh(
      positions,
      indices,
      config as Parameters<typeof generateSoloNavMesh>[2],
      true,
    );
    return {
      result: result as { success: boolean; navMesh?: NavMesh; error?: string },
      durationMs: performance.now() - t0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[navmesh] generate failed', { cs: config.cs, ch: config.ch, message });
    return {
      result: { success: false, error: message },
      durationMs: performance.now() - t0,
    };
  }
}

function buildConfigList(bounds: ReturnType<typeof computeBounds>): RecastGenConfig[] {
  const sizes = pickNavCellSizes(bounds);
  const configs = sizes.map((cs) => buildNavConfig(cs));
  configs.push(buildNavConfig(sizes[sizes.length - 1], true));
  return configs;
}

export function clearNavMesh(): void {
  if (currentNavMesh) {
    try {
      currentNavMesh.destroy();
    } catch {
      /* */
    }
    currentNavMesh = null;
  }
}

export function getNavMesh(): NavMesh | null {
  return currentNavMesh;
}

export function isNavMeshReady(): boolean {
  return currentNavMesh !== null;
}

export async function generateNavMeshFromMap(
  mapRoot: THREE.Object3D,
  fastMode: boolean = FAST_NAV_MESH,
): Promise<{ success: boolean; error?: string; durationMs: number }> {
  await ensureRecastLoaded();
  clearNavMesh();
  const meshes = collectMeshes(mapRoot);
  if (!meshes.length) return { success: false, error: 'No mesh geometry in file.', durationMs: 0 };
  const [positions, indices] = extractWorldPositionsAndIndices(meshes);
  const triCount = indices.length / 3;
  if (triCount === 0) return { success: false, error: 'Map has no triangles.', durationMs: 0 };

  const bounds = computeBounds(positions, indices);
  const configs = buildConfigList(bounds);
  const tryLimit = fastMode ? 2 : configs.length;

  let result: { success: boolean; navMesh?: NavMesh; error?: string } | null = null;
  let durationMs = 0;
  let lastError = '';

  outer: for (let oi = 0; oi < 2; oi++) {
    const orient = oi === 0 ? 'identity' : 'swapYZ';
    const orientedPositions = remapPositions(positions, orient);
    const orientedIndices = oi === 0 ? indices : remapIndices(indices);
    const orientedBounds = computeBounds(orientedPositions, orientedIndices);
    const orientedConfigs = oi === 0 ? configs : buildConfigList(orientedBounds).slice(0, 2);

    for (let ci = 0; ci < Math.min(tryLimit, orientedConfigs.length); ci++) {
      const cfg = orientedConfigs[ci];
      const out = tryGenerate(orientedPositions, orientedIndices, cfg);
      durationMs += out.durationMs;
      result = out.result;
      if (result.success) {
        console.info('[navmesh] built', {
          cs: cfg.cs,
          ch: cfg.ch,
          walkableRadius: cfg.walkableRadius,
          agentRadius: NAV_MESH_AGENT_RADIUS,
        });
        break outer;
      }
      lastError = result.error || lastError;
    }
  }

  if (!result?.success) {
    return { success: false, error: lastError || 'Failed to create nav mesh', durationMs };
  }
  currentNavMesh = result.navMesh!;
  return { success: true, durationMs };
}

export async function ensureNavMeshForMap(
  mapRoot: THREE.Object3D,
): Promise<{ success: boolean; error?: string; durationMs: number }> {
  let out = await generateNavMeshFromMap(mapRoot, FAST_NAV_MESH);
  if (!out.success && FAST_NAV_MESH && FALLBACK_FULL_NAV_MESH) {
    out = await generateNavMeshFromMap(mapRoot, false);
  }
  return out;
}
