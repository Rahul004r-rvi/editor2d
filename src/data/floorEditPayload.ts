import { applyWalkGridEdits, type Floor2DMap, type FloorBlock, type FloorShape } from '../floor2d';

export const FLOOR_EDIT_VERSION = 2;

export type NavmeFloorPoint = { x: number; z: number };

export type NavmeFloorItem = {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
  label: string;
  fill?: string;
  shape?: FloorShape;
  points?: NavmeFloorPoint[];
  stroke?: string;
};

/** Serializable floor editor state stored in `navme_floor_edits.floor_data`. */
export type NavmeFloorEditPayload = {
  version: number;
  sliceY: number;
  mapCode: string;
  cellSize: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  walkGrid: number[];
  /** Solid objects (v1 used `zones` for these). */
  objects: NavmeFloorItem[];
  /** Labeled dotted-outline zones. */
  zones: NavmeFloorItem[];
};

export type NavmeFloorEditRow = {
  poi_type: string;
  map_code: string;
  floor_slice_y: number;
  floor_data: NavmeFloorEditPayload;
  updated_at?: string;
};

function itemsToBlocks(items: NavmeFloorItem[]): FloorBlock[] {
  return items.map((z) => ({
    id: z.id,
    x: z.x,
    z: z.z,
    w: z.w,
    d: z.d,
    label: z.label ?? '',
    fill: z.fill ?? '',
    shape: z.shape,
    points: z.points?.map((p) => ({ x: p.x, z: p.z })),
    stroke: z.stroke,
  }));
}

function blocksToItems(blocks: FloorBlock[]): NavmeFloorItem[] {
  return blocks.map((b) => ({
    id: b.id,
    x: b.x,
    z: b.z,
    w: b.w,
    d: b.d,
    label: b.label ?? '',
    fill: b.fill,
    shape: b.shape,
    points: b.points?.map((p) => ({ x: p.x, z: p.z })),
    stroke: b.stroke,
  }));
}

export function buildFloorEditPayload(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  zones: FloorBlock[],
  sliceY: number,
  mapCode: string,
): NavmeFloorEditPayload {
  return {
    version: FLOOR_EDIT_VERSION,
    sliceY,
    mapCode,
    cellSize: map.cellSize,
    minX: map.minX,
    maxX: map.maxX,
    minZ: map.minZ,
    maxZ: map.maxZ,
    cols: map.cols,
    rows: map.rows,
    walkGrid: Array.from(walk),
    objects: blocksToItems(objects),
    zones: blocksToItems(zones),
  };
}

/** Merge a saved JSON snapshot onto a freshly built base map. */
export function applySavedFloorEditToMap(
  base: Floor2DMap,
  payload: NavmeFloorEditPayload | null | undefined,
): Floor2DMap {
  if (!payload) return base;

  const parsed = normalizePayload(payload);
  if (!parsed) return base;

  const objects = itemsToBlocks(parsed.objects);
  const zones = itemsToBlocks(parsed.zones);

  const gridOk =
    base.cols === parsed.cols &&
    base.rows === parsed.rows &&
    Math.abs(base.cellSize - parsed.cellSize) < 1e-6 &&
    Math.abs(base.minX - parsed.minX) < 1e-3 &&
    Math.abs(base.minZ - parsed.minZ) < 1e-3;

  if (!gridOk || !parsed.walkGrid?.length) {
    console.warn('[floorEdit] Grid mismatch — restoring objects/zones only');
    return { ...base, objects, zones, sliceY: parsed.sliceY };
  }

  const walk = new Uint8Array(parsed.walkGrid.map((v) => (v ? 1 : 0)));
  if (walk.length !== base.cols * base.rows) {
    console.warn('[floorEdit] walkGrid length mismatch — objects/zones only');
    return { ...base, objects, zones, sliceY: parsed.sliceY };
  }

  return applyWalkGridEdits({ ...base, sliceY: parsed.sliceY }, walk, objects, zones);
}

function normalizePayload(raw: NavmeFloorEditPayload): NavmeFloorEditPayload | null {
  if (raw.version === FLOOR_EDIT_VERSION) {
    if (!Array.isArray(raw.walkGrid)) return null;
    return {
      ...raw,
      objects: Array.isArray(raw.objects) ? raw.objects : [],
      zones: Array.isArray(raw.zones) ? raw.zones : [],
    };
  }
  // v1: everything was stored in `zones` — treat as solid objects
  const legacy = raw as NavmeFloorEditPayload & { zones?: NavmeFloorItem[] };
  if (legacy.version === 1 && Array.isArray(legacy.zones) && Array.isArray(legacy.walkGrid)) {
    return {
      version: FLOOR_EDIT_VERSION,
      sliceY: legacy.sliceY,
      mapCode: legacy.mapCode,
      cellSize: legacy.cellSize,
      minX: legacy.minX,
      maxX: legacy.maxX,
      minZ: legacy.minZ,
      maxZ: legacy.maxZ,
      cols: legacy.cols,
      rows: legacy.rows,
      walkGrid: legacy.walkGrid,
      objects: legacy.zones,
      zones: [],
    };
  }
  return null;
}

export function parseFloorEditPayload(raw: unknown): NavmeFloorEditPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  return normalizePayload(raw as NavmeFloorEditPayload);
}
