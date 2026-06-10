import {
  applyWalkGridEdits,
  type Floor2DMap,
  type FloorBlock,
  type FloorLevel,
  type FloorShape,
} from '../floor2d';

export const FLOOR_EDIT_VERSION = 4;

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
  floorY?: number;
};

/** Named Y-level (Floor 1, Ground Floor, …) with optional per-level editor state. */
export type NavmeFloorLevel = {
  id: string;
  label: string;
  floorY: number;
  walkGrid?: number[];
  objects?: NavmeFloorItem[];
  zones?: NavmeFloorItem[];
  gridCols?: number;
  gridRows?: number;
  gridCellSize?: number;
  gridMinX?: number;
  gridMinZ?: number;
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
  objects: NavmeFloorItem[];
  zones: NavmeFloorItem[];
  /** Named floor levels (Y slices). */
  floors: NavmeFloorLevel[];
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
    floorY: z.floorY,
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
    floorY: b.floorY,
  }));
}

function levelToNav(level: FloorLevel): NavmeFloorLevel {
  return {
    id: level.id,
    label: level.label,
    floorY: level.floorY,
    walkGrid: level.walkGrid ? [...level.walkGrid] : undefined,
    objects: level.objects?.length ? blocksToItems(level.objects) : undefined,
    zones: level.zones?.length ? blocksToItems(level.zones) : undefined,
    gridCols: level.gridCols,
    gridRows: level.gridRows,
    gridCellSize: level.gridCellSize,
    gridMinX: level.gridMinX,
    gridMinZ: level.gridMinZ,
  };
}

function navToLevel(raw: NavmeFloorLevel | NavmeFloorItem): FloorLevel {
  const item = raw as NavmeFloorLevel & NavmeFloorItem;
  const isLegacyRegion =
    typeof item.w === 'number' &&
    typeof item.d === 'number' &&
    item.walkGrid === undefined &&
    item.gridCols === undefined;
  if (isLegacyRegion) {
    return {
      id: item.id,
      label: item.label?.trim() || 'Floor',
      floorY: item.floorY ?? 0,
    };
  }
  return {
    id: item.id,
    label: item.label ?? 'Floor',
    floorY: item.floorY,
    walkGrid: item.walkGrid ? [...item.walkGrid] : undefined,
    objects: item.objects?.length ? itemsToBlocks(item.objects) : undefined,
    zones: item.zones?.length ? itemsToBlocks(item.zones) : undefined,
    gridCols: item.gridCols,
    gridRows: item.gridRows,
    gridCellSize: item.gridCellSize,
    gridMinX: item.gridMinX,
    gridMinZ: item.gridMinZ,
  };
}

function levelsToNav(levels: FloorLevel[]): NavmeFloorLevel[] {
  return levels.map(levelToNav);
}

export function buildFloorEditPayload(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  zones: FloorBlock[],
  floors: FloorLevel[],
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
    floors: levelsToNav(floors),
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

  const floors = parsed.floors.map(navToLevel);
  const active =
    floors.find((f) => Math.abs(f.floorY - parsed.sliceY) < 1e-4) ??
    floors[0];

  const objects = active?.objects?.length ? active.objects : itemsToBlocks(parsed.objects);
  const zones = active?.zones?.length ? active.zones : itemsToBlocks(parsed.zones);

  const gridOk =
    base.cols === parsed.cols &&
    base.rows === parsed.rows &&
    Math.abs(base.cellSize - parsed.cellSize) < 1e-6 &&
    Math.abs(base.minX - parsed.minX) < 1e-3 &&
    Math.abs(base.minZ - parsed.minZ) < 1e-3;

  const activeWalk =
    active?.walkGrid &&
    active.gridCols === base.cols &&
    active.gridRows === base.rows &&
    active.walkGrid.length === base.cols * base.rows
      ? new Uint8Array(active.walkGrid.map((v) => (v ? 1 : 0)))
      : null;

  if (!gridOk || !parsed.walkGrid?.length) {
    console.warn('[floorEdit] Grid mismatch — restoring objects/zones/floors only');
    return { ...base, objects, zones, floors, sliceY: parsed.sliceY };
  }

  const walk =
    activeWalk ??
    new Uint8Array(parsed.walkGrid.map((v) => (v ? 1 : 0)));
  if (walk.length !== base.cols * base.rows) {
    console.warn('[floorEdit] walkGrid length mismatch — objects/zones/floors only');
    return { ...base, objects, zones, floors, sliceY: parsed.sliceY };
  }

  return applyWalkGridEdits({ ...base, sliceY: parsed.sliceY }, walk, objects, zones, floors);
}

function normalizePayload(raw: NavmeFloorEditPayload): NavmeFloorEditPayload | null {
  if (raw.version === FLOOR_EDIT_VERSION) {
    if (!Array.isArray(raw.walkGrid)) return null;
    return {
      ...raw,
      objects: Array.isArray(raw.objects) ? raw.objects : [],
      zones: Array.isArray(raw.zones) ? raw.zones : [],
      floors: Array.isArray(raw.floors) ? raw.floors : [],
    };
  }
  if (raw.version === 3 && Array.isArray(raw.walkGrid)) {
    return {
      version: FLOOR_EDIT_VERSION,
      sliceY: raw.sliceY,
      mapCode: raw.mapCode,
      cellSize: raw.cellSize,
      minX: raw.minX,
      maxX: raw.maxX,
      minZ: raw.minZ,
      maxZ: raw.maxZ,
      cols: raw.cols,
      rows: raw.rows,
      walkGrid: raw.walkGrid,
      objects: Array.isArray(raw.objects) ? raw.objects : [],
      zones: Array.isArray(raw.zones) ? raw.zones : [],
      floors: Array.isArray(raw.floors) ? raw.floors : [],
    };
  }
  if (raw.version === 2 && Array.isArray(raw.walkGrid)) {
    return {
      version: FLOOR_EDIT_VERSION,
      sliceY: raw.sliceY,
      mapCode: raw.mapCode,
      cellSize: raw.cellSize,
      minX: raw.minX,
      maxX: raw.maxX,
      minZ: raw.minZ,
      maxZ: raw.maxZ,
      cols: raw.cols,
      rows: raw.rows,
      walkGrid: raw.walkGrid,
      objects: Array.isArray(raw.objects) ? raw.objects : [],
      zones: Array.isArray(raw.zones) ? raw.zones : [],
      floors: [],
    };
  }
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
      floors: [],
    };
  }
  return null;
}

export function parseFloorEditPayload(raw: unknown): NavmeFloorEditPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  return normalizePayload(raw as NavmeFloorEditPayload);
}
