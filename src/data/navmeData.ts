import { DEFAULT_GTA } from '../config';
import { getSupabase } from './supabaseClient';
import { NAVME_TABLES } from './navmeTables';
import type { NavMapPoi } from '../pois';

export type NavmeLoginRow = {
  poi_type: string;
  map_code: string | null;
  client_id: string | null;
  client_secret: string | null;
};

export type NavmeProjectConfig = {
  poiType: string;
  mapCode: string;
  clientId: string;
  clientSecret: string;
};

function normType(value: string): string {
  return value.trim().toLowerCase();
}

export function getPoiTypeFromUrl(): string {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const fromUrl = (params.get('poi_type') || params.get('category') || '').trim();
  if (fromUrl) return fromUrl;
  const env = import.meta.env.VITE_NAVME_POI_TYPE;
  if (typeof env === 'string' && env.trim()) return env.trim();
  return 'IIPC';
}

export async function fetchNavmeLoginTypes(): Promise<string[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb.from(NAVME_TABLES.logins).select('poi_type').order('poi_type');
  if (error) {
    console.warn('[navmeData] navme_logins types:', error.message);
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of data || []) {
    const t = String((row as { poi_type?: string }).poi_type ?? '').trim();
    if (!t || seen.has(normType(t))) continue;
    seen.add(normType(t));
    out.push(t);
  }
  return out;
}

export async function fetchNavmeLoginByPoiType(poiType: string): Promise<NavmeLoginRow | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const want = normType(poiType);
  const { data, error } = await sb.from(NAVME_TABLES.logins).select('poi_type, map_code, client_id, client_secret');
  if (error) {
    console.warn('[navmeData] navme_logins:', error.message);
    return null;
  }
  const row = (data || []).find((entry) => normType(String((entry as NavmeLoginRow).poi_type ?? '')) === want) as
    | NavmeLoginRow
    | undefined;
  return row ?? null;
}

export async function resolveNavmeProject(poiType: string): Promise<NavmeProjectConfig> {
  const row = await fetchNavmeLoginByPoiType(poiType);
  const mapFromUrl = new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('map')?.trim();
  return {
    poiType: row?.poi_type?.trim() || poiType,
    mapCode: mapFromUrl || row?.map_code?.trim() || DEFAULT_GTA.defaultMapCode,
    clientId: row?.client_id?.trim() || DEFAULT_GTA.defaultClientId,
    clientSecret: row?.client_secret?.trim() || DEFAULT_GTA.defaultClientSecret,
  };
}

export async function fetchNavmePoisByPoiType(poiType: string): Promise<NavMapPoi[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const want = normType(poiType);
  const { data, error } = await sb.from(NAVME_TABLES.pois).select('*');
  if (error) {
    console.warn('[navmeData] navme_pois:', error.message);
    return [];
  }
  const roomMap = new Map<string, NavMapPoi>();
  for (const item of data || []) {
    const row = item as {
      id?: string | number;
      poi_name?: string;
      poi_type?: string;
      pos_x?: number | string | null;
      pos_y?: number | string | null;
      pos_z?: number | string | null;
      is_active?: boolean | null;
    };
    if (row.is_active === false) continue;
    const rid = String(row.id ?? '');
    if (!rid || roomMap.has(rid)) continue;
    const category = String(row.poi_type ?? '').trim();
    if (normType(category) !== want) continue;
    roomMap.set(rid, {
      id: 'room-' + rid,
      name: row.poi_name?.trim() || `POI ${rid}`,
      x: Number(row.pos_x ?? 0),
      y: Number(row.pos_y ?? 0),
      z: Number(row.pos_z ?? 0),
    });
  }
  const out = Array.from(roomMap.values());
  out.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[navmeData] ${out.length} POI(s) for poi_type "${poiType}"`);
  return out;
}
