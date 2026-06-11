import * as THREE from 'three';

export type NavMapPoi = { id: string; name: string; x: number; y: number; z: number };

let NAV_MAP_POIS: NavMapPoi[] = [];

export function getNavMapPois(): NavMapPoi[] {
  return NAV_MAP_POIS;
}

export function setNavMapPois(pois: NavMapPoi[]): void {
  NAV_MAP_POIS = pois;
}

export function findNavMapPoi(id: string): NavMapPoi | null {
  return NAV_MAP_POIS.find((p) => p.id === id) ?? null;
}

/** Demo POIs from map bounds when no Supabase is configured. */
export function buildDemoPoisFromMap(mapRoot: THREE.Object3D): NavMapPoi[] {
  const box = new THREE.Box3().setFromObject(mapRoot);
  if (box.isEmpty()) {
    return [
      { id: 'demo-origin', name: 'Entrance', x: 0, y: 0, z: 0 },
      { id: 'demo-dest', name: 'Destination', x: 0, y: 0, z: 5 },
    ];
  }
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const y = center.y;
  const dx = size.x * 0.35;
  const dz = size.z * 0.35;
  return [
    { id: 'poi-1', name: 'Entrance', x: center.x - dx, y, z: center.z - dz },
    { id: 'poi-2', name: 'Center', x: center.x, y, z: center.z },
    { id: 'poi-3', name: 'North wing', x: center.x, y, z: center.z + dz },
    { id: 'poi-4', name: 'East wing', x: center.x + dx, y, z: center.z },
    { id: 'poi-5', name: 'South exit', x: center.x, y, z: center.z - dz },
  ];
}

export const ZONE_ROUTE_PREFIX = 'zone:';
export const FLOOR_ROUTE_PREFIX = 'floor:';

export type RouteZoneOption = { id: string; label: string };
export type RouteFloorOption = { id: string; label: string; floorY?: number };

export function zoneRouteId(zoneId: string): string {
  return `${ZONE_ROUTE_PREFIX}${zoneId}`;
}

export function isZoneRouteId(id: string): boolean {
  return id.startsWith(ZONE_ROUTE_PREFIX);
}

export function parseZoneRouteId(id: string): string | null {
  return isZoneRouteId(id) ? id.slice(ZONE_ROUTE_PREFIX.length) : null;
}

export function floorRouteId(floorId: string): string {
  return `${FLOOR_ROUTE_PREFIX}${floorId}`;
}

export function isFloorRouteId(id: string): boolean {
  return id.startsWith(FLOOR_ROUTE_PREFIX);
}

export function parseFloorRouteId(id: string): string | null {
  return isFloorRouteId(id) ? id.slice(FLOOR_ROUTE_PREFIX.length) : null;
}

export type PoiFloorLevelRef = { floorY: number; label?: string };

export function floorLabelForPoi(poi: NavMapPoi, floorLevels: PoiFloorLevelRef[]): string {
  if (floorLevels.length === 0) return `Y ${poi.y.toFixed(1)}`;
  const y = nearestFloorYForPoi(poi.y, floorLevels);
  const floor = floorLevels.find((f) => Math.abs(f.floorY - y) < 1e-4);
  return floor?.label?.trim() || `Y ${y.toFixed(1)}`;
}

/** Floor level whose Y is closest to a POI's height. */
export function nearestFloorYForPoi(poiY: number, floorLevels: PoiFloorLevelRef[]): number {
  const floor = floorLevelForPoiY(poiY, floorLevels);
  return floor?.floorY ?? poiY;
}

/** Named floor level for a POI Y — midpoint bands between adjacent slice heights. */
export function floorLevelForPoiY<T extends PoiFloorLevelRef>(
  poiY: number,
  floorLevels: T[],
): T | null {
  if (floorLevels.length === 0) return null;
  if (floorLevels.length === 1) return floorLevels[0];

  const sorted = [...floorLevels].sort((a, b) => a.floorY - b.floorY);
  if (poiY < (sorted[0].floorY + sorted[1].floorY) * 0.5) return sorted[0];
  if (poiY >= (sorted[sorted.length - 2].floorY + sorted[sorted.length - 1].floorY) * 0.5) {
    return sorted[sorted.length - 1];
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const mid = (sorted[i].floorY + sorted[i + 1].floorY) * 0.5;
    if (poiY < mid) return sorted[i];
  }
  return sorted[sorted.length - 1];
}

function yBandAroundSlice(targetY: number, floorLevels: PoiFloorLevelRef[]): number {
  const ys = [...new Set(floorLevels.map((f) => f.floorY))].sort((a, b) => a - b);
  let below = -Infinity;
  let above = Infinity;
  for (const y of ys) {
    if (y < targetY - 1e-4) below = y;
    if (y > targetY + 1e-4) {
      above = y;
      break;
    }
  }
  const halfBelow = below === -Infinity ? Infinity : (targetY - below) / 2;
  const halfAbove = above === Infinity ? Infinity : (above - targetY) / 2;
  return Math.min(halfBelow, halfAbove, 3);
}

/**
 * POIs for one floor slice: each POI belongs to the nearest named floor Y.
 * When previewing an unsaved Y, uses a band between adjacent floor heights.
 */
function sortedFloorLevels<T extends PoiFloorLevelRef>(floorLevels: T[]): T[] {
  return [...floorLevels].sort((a, b) => a.floorY - b.floorY);
}

export function floorIndexForLevel<T extends PoiFloorLevelRef>(
  floor: T,
  floorLevels: T[],
): number {
  const sorted = sortedFloorLevels(floorLevels);
  const idx = sorted.findIndex((f) => f.floorY === floor.floorY);
  return idx >= 0 ? idx : 0;
}

/**
 * POIs visible when a floor is selected: Floor 1 → that level only;
 * higher floors include POIs from every level below through the selected one.
 */
export function filterPoisCumulativeThroughFloor<T extends PoiFloorLevelRef>(
  pois: NavMapPoi[],
  activeFloor: T,
  floorLevels: T[],
): NavMapPoi[] {
  if (pois.length === 0 || floorLevels.length === 0) return pois;
  const sorted = sortedFloorLevels(floorLevels);
  const activeIdx = floorIndexForLevel(activeFloor, floorLevels);
  if (activeIdx <= 0) {
    return filterPoisByFloorY(pois, activeFloor.floorY, floorLevels);
  }
  const allowed = new Set(sorted.slice(0, activeIdx + 1).map((f) => f.floorY));
  return pois.filter((p) => {
    const y = nearestFloorYForPoi(p.y, floorLevels);
    for (const fy of allowed) {
      if (Math.abs(y - fy) < 1e-4) return true;
    }
    return false;
  });
}

/** POIs that belong on one stacked plate for the current floor selection. */
export function filterPoisForStackedPlate<T extends PoiFloorLevelRef>(
  pois: NavMapPoi[],
  plateFloor: T,
  activeFloor: T,
  floorLevels: T[],
): NavMapPoi[] {
  const sorted = sortedFloorLevels(floorLevels);
  const plateIdx = sorted.findIndex((f) => f.floorY === plateFloor.floorY);
  const activeIdx = floorIndexForLevel(activeFloor, floorLevels);
  if (plateIdx < 0 || plateIdx > activeIdx) return [];
  return pois.filter(
    (p) => Math.abs(nearestFloorYForPoi(p.y, floorLevels) - plateFloor.floorY) < 0.25,
  );
}

export function filterPoisByFloorY(
  pois: NavMapPoi[],
  targetFloorY: number,
  floorLevels: PoiFloorLevelRef[],
): NavMapPoi[] {
  if (pois.length === 0) return pois;

  if (floorLevels.length === 0) {
    const band = 2.5;
    return pois.filter((p) => Math.abs(p.y - targetFloorY) <= band);
  }

  const hasNamedFloor = floorLevels.some((f) => Math.abs(f.floorY - targetFloorY) < 1e-4);
  if (hasNamedFloor) {
    return pois.filter(
      (p) => Math.abs(nearestFloorYForPoi(p.y, floorLevels) - targetFloorY) < 1e-4,
    );
  }

  const band = yBandAroundSlice(targetFloorY, floorLevels);
  return pois.filter((p) => Math.abs(p.y - targetFloorY) <= band);
}

export function fillPoiSelect(
  select: HTMLSelectElement,
  placeholder: string,
  pois: NavMapPoi[] = NAV_MAP_POIS,
  excludeId?: string,
  selectedId?: string,
): void {
  fillRouteEndpointSelect(select, placeholder, pois, [], [], excludeId, selectedId);
}

/** Origin/destination dropdown with POIs, zones, and named floor regions. */
export function fillRouteEndpointSelect(
  select: HTMLSelectElement,
  placeholder: string,
  pois: NavMapPoi[] = NAV_MAP_POIS,
  zones: RouteZoneOption[] = [],
  floors: RouteFloorOption[] = [],
  excludeId?: string,
  selectedId?: string,
  poiFloorLevels?: PoiFloorLevelRef[],
): void {
  const want = selectedId !== undefined ? selectedId : select.value;
  select.replaceChildren();
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = placeholder;
  select.appendChild(ph);

  let canRestore = want === '';

  if (pois.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'POIs';
    for (const poi of pois) {
      if (excludeId && poi.id === excludeId) continue;
      if (poi.id === want) canRestore = true;
      const opt = document.createElement('option');
      opt.value = poi.id;
      opt.textContent =
        poiFloorLevels && poiFloorLevels.length >= 2
          ? `${poi.name} (${floorLabelForPoi(poi, poiFloorLevels)})`
          : poi.name;
      group.appendChild(opt);
    }
    select.appendChild(group);
  }

  if (zones.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Zones';
    for (const zone of zones) {
      const rid = zoneRouteId(zone.id);
      if (excludeId && rid === excludeId) continue;
      if (rid === want) canRestore = true;
      const opt = document.createElement('option');
      opt.value = rid;
      opt.textContent = zone.label.trim() || 'Untitled zone';
      group.appendChild(opt);
    }
    select.appendChild(group);
  }

  if (floors.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Floors';
    for (const floor of floors) {
      const rid = floorRouteId(floor.id);
      if (excludeId && rid === excludeId) continue;
      if (rid === want) canRestore = true;
      const opt = document.createElement('option');
      opt.value = rid;
      const yHint = floor.floorY !== undefined ? ` (Y=${floor.floorY})` : '';
      opt.textContent = `${floor.label.trim() || 'Untitled floor'}${yHint}`;
      group.appendChild(opt);
    }
    select.appendChild(group);
  }

  select.value = want && canRestore ? want : '';
}
