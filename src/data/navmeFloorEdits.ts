import { getSupabase } from './supabaseClient';
import { NAVME_TABLES } from './navmeTables';
import {
  buildFloorEditPayload,
  parseFloorEditPayload,
  type NavmeFloorEditPayload,
  type NavmeFloorEditRow,
} from './floorEditPayload';
import type { Floor2DMap, FloorBlock } from '../floor2d';

function normMapCode(code: string): string {
  return code.trim().toUpperCase();
}

function normPoiType(poiType: string): string {
  return poiType.trim();
}

export async function fetchNavmeFloorEdit(
  poiType: string,
  mapCode: string,
): Promise<NavmeFloorEditRow | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const wantMap = normMapCode(mapCode);
  const { data, error } = await sb
    .from(NAVME_TABLES.floorEdits)
    .select('poi_type, map_code, floor_slice_y, floor_data, updated_at')
    .eq('poi_type', normPoiType(poiType))
    .eq('map_code', wantMap)
    .maybeSingle();
  if (error) {
    console.warn('[navmeFloorEdits] fetch:', error.message);
    return null;
  }
  const row = data as NavmeFloorEditRow | null;
  if (!row) return null;
  const payload = parseFloorEditPayload(row.floor_data);
  if (!payload) {
    console.warn('[navmeFloorEdits] Invalid floor_data JSON for', normPoiType(poiType), wantMap);
    return null;
  }
  return { ...row, floor_data: payload };
}

export async function saveNavmeFloorEdit(
  poiType: string,
  mapCode: string,
  sliceY: number,
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  zones: FloorBlock[],
): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: 'Supabase not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)' };
  }
  const payload = buildFloorEditPayload(map, walk, objects, zones, sliceY, normMapCode(mapCode));
  const row = {
    poi_type: normPoiType(poiType),
    map_code: normMapCode(mapCode),
    floor_slice_y: sliceY,
    floor_data: payload,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from(NAVME_TABLES.floorEdits).upsert(row, {
    onConflict: 'poi_type,map_code',
  });
  if (error) {
    console.error('[navmeFloorEdits] save:', error.message);
    return { ok: false, error: error.message };
  }
  console.log(
    `[navmeFloorEdits] Saved ${payload.objects.length} object(s), ${payload.zones.length} zone(s) for ${row.poi_type} / ${row.map_code}`,
  );
  return { ok: true };
}

export type { NavmeFloorEditPayload, NavmeFloorEditRow };
