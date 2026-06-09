import type * as THREE from 'three';
import { exportFloorSliceTriangles } from './exportFloorSlice';
import type { AnalyzedFloorPlan } from './floorPlan';

const SLICE_ANALYZE_URL = '/api/floor/analyze-slice';

let analyzeInFlight: Promise<AnalyzedFloorPlan | null> | null = null;
let analyzeKey = '';

export async function fetchAnalyzedFloorPlanFromMap(
  mapRoot: THREE.Object3D,
  sliceY: number,
  cellSize = 0.1,
): Promise<AnalyzedFloorPlan | null> {
  const triangles = exportFloorSliceTriangles(mapRoot, sliceY);
  if (triangles.length < 9) {
    console.warn('[fetchFloorPlan] No floor triangles at sliceY', sliceY);
    return null;
  }

  const key = `${sliceY}:${cellSize}:${triangles.length}`;
  if (analyzeInFlight && analyzeKey === key) return analyzeInFlight;

  analyzeKey = key;
  analyzeInFlight = (async () => {
    try {
      const res = await fetch(SLICE_ANALYZE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triangles, sliceY, cellSize }),
      });
      if (!res.ok) {
        const text = await res.text();
        let message = res.statusText;
        try {
          const err = JSON.parse(text) as { error?: string };
          if (err.error) message = err.error;
        } catch {
          if (text) message = text.slice(0, 200);
        }
        console.warn('[fetchFloorPlan]', message);
        return null;
      }
      return (await res.json()) as AnalyzedFloorPlan;
    } catch (err) {
      console.warn('[fetchFloorPlan] Python analyzer unavailable — using browser slice fallback', err);
      return null;
    } finally {
      analyzeInFlight = null;
    }
  })();

  return analyzeInFlight;
}

/** @deprecated Use fetchAnalyzedFloorPlanFromMap — GLB upload fails on Draco meshes. */
export async function fetchAnalyzedFloorPlan(
  mapRoot: THREE.Object3D,
  sliceY: number,
  cellSize = 0.1,
): Promise<AnalyzedFloorPlan | null> {
  return fetchAnalyzedFloorPlanFromMap(mapRoot, sliceY, cellSize);
}

export async function isFloorAnalyzerAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/floor/health', { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}
