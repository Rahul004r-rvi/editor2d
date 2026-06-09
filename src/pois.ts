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

export type RouteZoneOption = { id: string; label: string };

export function zoneRouteId(zoneId: string): string {
  return `${ZONE_ROUTE_PREFIX}${zoneId}`;
}

export function isZoneRouteId(id: string): boolean {
  return id.startsWith(ZONE_ROUTE_PREFIX);
}

export function parseZoneRouteId(id: string): string | null {
  return isZoneRouteId(id) ? id.slice(ZONE_ROUTE_PREFIX.length) : null;
}

export function fillPoiSelect(
  select: HTMLSelectElement,
  placeholder: string,
  pois: NavMapPoi[] = NAV_MAP_POIS,
  excludeId?: string,
  selectedId?: string,
): void {
  fillRouteEndpointSelect(select, placeholder, pois, [], excludeId, selectedId);
}

/** Origin/destination dropdown with POIs and labeled floor zones. */
export function fillRouteEndpointSelect(
  select: HTMLSelectElement,
  placeholder: string,
  pois: NavMapPoi[] = NAV_MAP_POIS,
  zones: RouteZoneOption[] = [],
  excludeId?: string,
  selectedId?: string,
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
      opt.textContent = poi.name;
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

  select.value = want && canRestore ? want : '';
}
