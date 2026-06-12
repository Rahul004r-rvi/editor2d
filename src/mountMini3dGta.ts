import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  DEFAULT_GTA,
  DEFER_NAV_MESH,
  DRACO_DECODER_PATH,
  FLOOR_SLICE_Y,
  type GtaConfig,
  getCreds,
  MULTISET_PUBLIC_API,
} from './config';
import { buildFloor2DFromMap } from './floor2d';
import { clearStairPortalCache } from './floor2dMultiRoute';
import { Floor2DView } from './floor2dView';
import { fetchAnalyzedFloorPlanFromMap } from './fetchFloorPlan';
import type { Floor2DTool, ZoneDrawMode } from './floor2dView';
import {
  buildMultiSetEndpoints,
  downloadMapMesh,
  getM2MTokenCached,
  resolveGlbCorsProxyPostUrl,
  resolveMultiSetApiBase,
} from './multiset';
import { applyMapTransparentGhostMaterial, disposeMapChildren } from './mapMaterials';
import { clearNavMesh, ensureNavMeshForMap, getNavMesh, isNavMeshReady } from './navmesh';
import { createRouteAndBreadcrumbs, type RouteAndBreadcrumbsHandle } from './route';
import {
  buildDemoPoisFromMap,
  fillRouteEndpointSelect,
  findNavMapPoi,
  getNavMapPois,
  setNavMapPois,
} from './pois';
import { applySavedFloorEditToMap } from './data/floorEditPayload';
import {
  fetchNavmeLoginTypes,
  fetchNavmePoisByPoiType,
  getPoiTypeFromUrl,
  resolveNavmeProject,
} from './data/navmeData';
import { fetchNavmeFloorEdit, saveNavmeFloorEdit, type NavmeFloorEditRow } from './data/navmeFloorEdits';
import { isSupabaseConfigured } from './data/supabaseClient';
import {
  applyNavMeLogoToToggleButton,
  createMini3dGtaMapButton,
  injectMini3dGtaUiStyles,
  POI_PIN_SVG_DEST,
  POI_PIN_SVG_ORIGIN,
} from './ui';

function createGltfLoaderWithDraco(): { loader: GLTFLoader; draco: DRACOLoader } {
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_DECODER_PATH);
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  return { loader, draco };
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

export interface Mini3dGtaMountOptions extends Partial<GtaConfig> {
  updateDocumentTitle?: boolean;
  /** When false, GLB + nav mesh start on page load (default true = wait for map open). */
  deferLoadUntilMapOpen?: boolean;
  suppressMapToggle?: boolean;
  /** Open fullscreen map immediately; no logo button click (default false). */
  autoStartFullscreen?: boolean;
  /** `2d` = top-down block floor plan at `floorSliceY`; `3d` = orbit GLB view. */
  viewMode?: '2d' | '3d';
  /** Y-up slice height for 2D floor (default {@link FLOOR_SLICE_Y}). */
  floorSliceY?: number;
}

export interface Mini3dGtaHandle {
  readonly rootElement: HTMLElement;
  readonly ready: Promise<void>;
  openFullscreen(): void;
  closeFullscreen(): void;
  setOrigin(x: number, y: number, z: number): void;
  setDestination(x: number, y: number, z: number): void;
  rebuildRoute(): void;
  getRouteState(): RouteAndBreadcrumbsHandle['state'] | null;
  dispose(): void;
}

const NOTIFY_BASE_STYLE =
  'position:absolute;top:8px;left:8px;right:8px;z-index:2;max-width:calc(100% - 16px);padding:10px 12px;border-radius:10px;font:12px/1.4 system-ui,sans-serif;color:#424242;background:rgba(255,255,255,0.92);border:1px solid #e0e0e0;backdrop-filter:blur(8px);pointer-events:none;';

export function mountMini3dGta(
  _container: HTMLElement,
  options: Mini3dGtaMountOptions = {},
): Mini3dGtaHandle {
  const cfg = { ...DEFAULT_GTA, ...options };
  const updateDocumentTitle = options.updateDocumentTitle === true;
  const autoStart = options.autoStartFullscreen === true;
  const viewMode = options.viewMode ?? '2d';
  const use2d = viewMode === '2d';
  let floorSliceY = options.floorSliceY ?? FLOOR_SLICE_Y;
  const deferHeavy = !autoStart && options.deferLoadUntilMapOpen !== false;
  const suppressMapToggle = options.suppressMapToggle === true || autoStart;

  let mountRoot: HTMLElement;
  let viewport: HTMLElement;
  let fsOverlay: HTMLElement | null = null;
  let toggleBtn: HTMLButtonElement | null = null;
  let originSelect: HTMLSelectElement | null = null;
  let destSelect: HTMLSelectElement | null = null;
  let mapOverlayLayer: HTMLDivElement | null = null;
  const poiLabelEls = new Map<string, HTMLSpanElement>();
  let originPinEl: HTMLDivElement | null = null;
  let destPinEl: HTMLDivElement | null = null;
  const overlayProject = new THREE.Vector3();
  let resizeViewportFn: (() => void) | null = null;
  let rebuildMapOverlayFn: (() => void) | null = null;
  let setFullscreenOpenFn: ((open: boolean) => void) | null = null;
  let applyPoiSelectionsFn: (() => void) | null = null;
  let floor2dView: Floor2DView | null = null;
  let floorAnalyzeGen = 0;
  let sliceDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let syncFloor2dRouteFn: (() => void) | null = null;
  let navMeshBuilding = false;
  let pendingFloorEdit: NavmeFloorEditRow | null = null;
  let saveInFlight = false;

  const uiCanvas = document.createElement('canvas');
  uiCanvas.style.cssText = use2d
    ? 'display:none;width:100%;height:100%;touch-action:none;'
    : 'display:block;width:100%;height:100%;touch-action:none;';

  const uiNotify = document.createElement('div');
  uiNotify.setAttribute('role', 'status');
  const uiPhase = document.createElement('div');
  const uiStatus = document.createElement('p');
  uiStatus.style.cssText = 'margin:0;font-size:12px;line-height:1.45;color:#424242;';
  uiNotify.append(uiPhase, uiStatus);

  injectMini3dGtaUiStyles();

  if (!suppressMapToggle) {
    toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'mini3dgta-map-toggle';
    applyNavMeLogoToToggleButton(toggleBtn);
  }

  fsOverlay = document.createElement('div');
  fsOverlay.className = 'mini3dgta-fs-overlay';

  const toolbar = document.createElement('div');
  toolbar.className = 'mini3dgta-fs-toolbar mini3dgta-fs-toolbar--with-map';

  const mkField = (
    labelText: string,
    fieldClass: string,
    labelClass: string,
    selectClass: string,
    pinIcon: string,
  ) => {
    const wrap = document.createElement('label');
    wrap.className = 'mini3dgta-fs-field ' + fieldClass;
    const labelRow = document.createElement('span');
    labelRow.className = 'mini3dgta-fs-field__label ' + labelClass;
    labelRow.innerHTML = pinIcon + '<span>' + labelText + '</span>';
    const select = document.createElement('select');
    select.className = 'mini3dgta-fs-select ' + selectClass;
    wrap.append(labelRow, select);
    return { wrap, select };
  };

  const originPinIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3" fill="#fff"/></svg>';
  const destPinIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3" fill="#fff"/></svg>';

  const originField = mkField('Origin', 'mini3dgta-fs-field--origin', 'mini3dgta-fs-field__label--origin', 'mini3dgta-fs-select--origin', originPinIcon);
  const destField = mkField('Destination', 'mini3dgta-fs-field--dest', 'mini3dgta-fs-field__label--dest', 'mini3dgta-fs-select--dest', destPinIcon);
  originSelect = originField.select;
  destSelect = destField.select;
  fillRouteEndpointSelect(originSelect, 'Choose origin…');
  fillRouteEndpointSelect(destSelect, 'Choose destination…');

  const poiTypeField = document.createElement('label');
  poiTypeField.className = 'mini3dgta-fs-field mini3dgta-fs-field--project';
  const poiTypeLabel = document.createElement('span');
  poiTypeLabel.className = 'mini3dgta-fs-field__label';
  poiTypeLabel.innerHTML = '<span>Project</span>';
  const poiTypeSelect = document.createElement('select');
  poiTypeSelect.className = 'mini3dgta-fs-select mini3dgta-fs-select--project';
  poiTypeField.append(poiTypeLabel, poiTypeSelect);

  const sliceField = document.createElement('label');
  sliceField.className = 'mini3dgta-fs-field mini3dgta-fs-field--slice';
  sliceField.style.display = use2d ? 'flex' : 'none';
  const sliceLabel = document.createElement('span');
  sliceLabel.className = 'mini3dgta-fs-field__label';
  sliceLabel.innerHTML = '<span>Floor slice (Y)</span>';
  const sliceInput = document.createElement('input');
  sliceInput.type = 'number';
  sliceInput.step = '0.1';
  sliceInput.value = String(floorSliceY);
  sliceInput.className = 'mini3dgta-fs-select';
  sliceInput.title =
    'Change Y to slice a height — draw/cut, then Add Floor. Click sidebar levels to switch back.';
  sliceField.append(sliceLabel, sliceInput);

  const mapCodeField = document.createElement('label');
  mapCodeField.className = 'mini3dgta-fs-field mini3dgta-fs-field--map';
  const mapCodeLabel = document.createElement('span');
  mapCodeLabel.className = 'mini3dgta-fs-field__label';
  mapCodeLabel.innerHTML = '<span>Map code</span>';
  const mapCodeInput = document.createElement('input');
  mapCodeInput.type = 'text';
  mapCodeInput.className = 'mini3dgta-fs-input mini3dgta-fs-input--map';
  mapCodeInput.placeholder = 'MAP_XXXXX';
  mapCodeInput.autocomplete = 'off';
  mapCodeInput.spellcheck = false;
  mapCodeField.append(mapCodeLabel, mapCodeInput);

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'mini3dgta-fs-refresh';
  refreshBtn.textContent = 'Refresh';

  const toolsBar = document.createElement('div');
  toolsBar.className = 'mini3dgta-fs-tools';
  toolsBar.style.display = use2d ? 'flex' : 'none';

  const analyzeBtn = document.createElement('button');
  analyzeBtn.type = 'button';
  analyzeBtn.className = 'mini3dgta-fs-analyze';
  analyzeBtn.textContent = 'Structure Analyze';

  const paintFloorBtn = document.createElement('button');
  paintFloorBtn.type = 'button';
  paintFloorBtn.className = 'mini3dgta-fs-tool';
  paintFloorBtn.textContent = 'Paint Floor';
  paintFloorBtn.title = 'Drag to add walkable floor at the current Y slice';

  const floorBtn = document.createElement('button');
  floorBtn.type = 'button';
  floorBtn.className = 'mini3dgta-fs-tool';
  floorBtn.textContent = 'Add Floor';
  floorBtn.title = 'Save current Y as a new level (Floor 1, Floor 2, …)';

  const renameFloorBtn = document.createElement('button');
  renameFloorBtn.type = 'button';
  renameFloorBtn.className = 'mini3dgta-fs-tool';
  renameFloorBtn.textContent = 'Rename Floor';
  renameFloorBtn.title = 'Rename the active floor level (e.g. Ground Floor)';
  renameFloorBtn.disabled = true;

  const deleteFloorBtn = document.createElement('button');
  deleteFloorBtn.type = 'button';
  deleteFloorBtn.className = 'mini3dgta-fs-tool mini3dgta-fs-tool--danger';
  deleteFloorBtn.textContent = 'Delete Floor';
  deleteFloorBtn.title = 'Delete the active floor level';
  deleteFloorBtn.disabled = true;

  const cutBtn = document.createElement('button');
  cutBtn.type = 'button';
  cutBtn.className = 'mini3dgta-fs-tool';
  cutBtn.textContent = 'Cut';
  cutBtn.title = 'Drag to carve empty space (remove floor area)';

  const objectBtn = document.createElement('button');
  objectBtn.type = 'button';
  objectBtn.className = 'mini3dgta-fs-tool';
  objectBtn.textContent = 'Object';
  objectBtn.title = 'Place solid object — choose rectangle or circle';

  const zoneBtn = document.createElement('button');
  zoneBtn.type = 'button';
  zoneBtn.className = 'mini3dgta-fs-tool';
  zoneBtn.textContent = 'Add Zone';
  zoneBtn.title = 'Draw new zones — rectangle or polygon';

  const editZoneBtn = document.createElement('button');
  editZoneBtn.type = 'button';
  editZoneBtn.className = 'mini3dgta-fs-tool';
  editZoneBtn.textContent = 'Edit Zone';
  editZoneBtn.title = 'Select zones and drag dots to move, resize, or reshape';

  const deleteZoneBtn = document.createElement('button');
  deleteZoneBtn.type = 'button';
  deleteZoneBtn.className = 'mini3dgta-fs-tool mini3dgta-fs-tool--danger';
  deleteZoneBtn.textContent = 'Delete Zone';
  deleteZoneBtn.title = 'Delete the selected zone';
  deleteZoneBtn.disabled = true;
  deleteZoneBtn.style.display = 'none';

  const shapeBar = document.createElement('div');
  shapeBar.className = 'mini3dgta-fs-shapes';
  shapeBar.style.display = 'none';
  const rectShapeBtn = document.createElement('button');
  rectShapeBtn.type = 'button';
  rectShapeBtn.className = 'mini3dgta-fs-shape mini3dgta-fs-shape--active';
  rectShapeBtn.textContent = 'Rectangle';
  const circleShapeBtn = document.createElement('button');
  circleShapeBtn.type = 'button';
  circleShapeBtn.className = 'mini3dgta-fs-shape';
  circleShapeBtn.textContent = 'Circle';
  shapeBar.append(rectShapeBtn, circleShapeBtn);

  const zoneShapeBar = document.createElement('div');
  zoneShapeBar.className = 'mini3dgta-fs-shapes mini3dgta-fs-zone-shapes';
  zoneShapeBar.style.display = 'none';
  const zoneRectBtn = document.createElement('button');
  zoneRectBtn.type = 'button';
  zoneRectBtn.className = 'mini3dgta-fs-shape mini3dgta-fs-shape--active';
  zoneRectBtn.textContent = 'Rectangle';
  zoneRectBtn.title = 'Drag rectangle zone';
  const zonePolyBtn = document.createElement('button');
  zonePolyBtn.type = 'button';
  zonePolyBtn.className = 'mini3dgta-fs-shape';
  zonePolyBtn.textContent = 'Polygon';
  zonePolyBtn.title = 'Click corners, Enter or click first point to close';
  zoneShapeBar.append(zoneRectBtn, zonePolyBtn);

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'mini3dgta-fs-tool';
  undoBtn.textContent = 'Undo';
  undoBtn.title = 'Undo last Add or Cut (Ctrl+Z)';
  undoBtn.disabled = true;

  const redoBtn = document.createElement('button');
  redoBtn.type = 'button';
  redoBtn.className = 'mini3dgta-fs-tool';
  redoBtn.textContent = 'Redo';
  redoBtn.title = 'Redo (Ctrl+Shift+Z)';
  redoBtn.disabled = true;

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'mini3dgta-fs-save';
  saveBtn.textContent = 'Save';
  saveBtn.title = 'Save floor map, regions, and zones to database';
  saveBtn.disabled = true;

  const navMeshBtn = document.createElement('button');
  navMeshBtn.type = 'button';
  navMeshBtn.className = 'mini3dgta-fs-tool';
  navMeshBtn.textContent = 'NavMesh';
  navMeshBtn.title = 'Show or hide walkable nav mesh overlay';

  const panBtn = document.createElement('button');
  panBtn.type = 'button';
  panBtn.className = 'mini3dgta-fs-tool mini3dgta-fs-tool--active';
  panBtn.textContent = 'Pan';

  const walls3dBtn = document.createElement('button');
  walls3dBtn.type = 'button';
  walls3dBtn.className = 'mini3dgta-fs-tool';
  walls3dBtn.textContent = '3D Walls';
  walls3dBtn.title = 'Extruded walls — left-drag orbit, right-drag pan, scroll zoom';

  toolsBar.append(
    analyzeBtn,
    paintFloorBtn,
    floorBtn,
    renameFloorBtn,
    deleteFloorBtn,
    cutBtn,
    objectBtn,
    zoneBtn,
    editZoneBtn,
    deleteZoneBtn,
    zoneShapeBar,
    shapeBar,
    undoBtn,
    redoBtn,
    saveBtn,
    navMeshBtn,
    panBtn,
    walls3dBtn,
  );

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mini3dgta-fs-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close map');
  toolbar.append(originField.wrap, destField.wrap, sliceField, closeBtn, poiTypeField, mapCodeField, refreshBtn);

  const fsBody = document.createElement('div');
  fsBody.style.cssText = 'position:relative;flex:1;min-height:0;display:flex;flex-direction:column;';

  const floor2dLayout = document.createElement('div');
  floor2dLayout.className = 'floor2d-layout';
  floor2dLayout.style.cssText = 'display:flex;flex:1;min-height:0;min-width:0;';

  mountRoot = document.createElement('div');
  mountRoot.className = 'mini3dgta-fs-map';
  viewport = mountRoot;
  if (!deferHeavy || autoStart) viewport.appendChild(uiCanvas);

  mapOverlayLayer = document.createElement('div');
  mapOverlayLayer.className = 'mini3dgta-map-overlay';
  mapOverlayLayer.setAttribute('aria-hidden', 'true');
  mountRoot.appendChild(mapOverlayLayer);
  uiNotify.style.cssText = NOTIFY_BASE_STYLE;
  uiPhase.style.cssText =
    'font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#9c27b0;margin-bottom:4px;';
  mountRoot.appendChild(uiNotify);
  if (use2d) {
    mapOverlayLayer.style.display = 'none';
  }
  floor2dLayout.appendChild(mountRoot);
  fsBody.appendChild(floor2dLayout);
  fsOverlay.append(toolbar, toolsBar, fsBody);

  document.body.appendChild(fsOverlay);
  if (toggleBtn) document.body.appendChild(toggleBtn);

  function setNotify(phase: string, message: string, level: 'loading' | 'done' | 'error' = 'loading') {
    uiPhase.textContent = phase;
    uiStatus.textContent = message;
    uiNotify.style.display = level === 'done' ? 'none' : 'block';
    uiPhase.style.color = level === 'loading' ? '#9c27b0' : level === 'done' ? '#4caf50' : '#e57373';
    if (updateDocumentTitle) {
      if (level === 'loading') document.title = `${phase} — ${cfg.baseTitle}`;
      else if (level === 'done') document.title = `${cfg.baseTitle} — ready`;
      else document.title = `${cfg.baseTitle} — error`;
    }
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a12);
  const camera = new THREE.PerspectiveCamera(55, 2, 0.05, 5000);
  camera.position.set(0, 2.5, 8);
  const renderer = new THREE.WebGLRenderer({ canvas: uiCanvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  const controls = new OrbitControls(camera, uiCanvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(4, 12, 6);
  scene.add(dir);
  const mapRoot = new THREE.Group();
  mapRoot.name = 'MapMesh';
  scene.add(mapRoot);
  let routeHandle: RouteAndBreadcrumbsHandle | null = null;
  const mapBounds = new THREE.Box3();

  function fitCameraToMap() {
    mapBounds.setFromObject(mapRoot);
    if (!mapBounds.isEmpty()) {
      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      mapBounds.getCenter(center);
      mapBounds.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z, 1);
      const dist = maxDim * 1.2;
      controls.target.copy(center);
      camera.position.set(center.x + dist * 0.35, center.y + dist * 0.25, center.z + dist);
      camera.near = Math.max(0.01, dist / 2000);
      camera.far = dist * 50;
      camera.updateProjectionMatrix();
    }
    controls.update();
  }

  function projectMapPoint(x: number, y: number, z: number) {
    overlayProject.set(x, y, z);
    overlayProject.project(camera);
    const w = Math.max(1, viewport.clientWidth);
    const h = Math.max(1, viewport.clientHeight);
    const visible = overlayProject.z >= -1 && overlayProject.z <= 1;
    return { x: (overlayProject.x * 0.5 + 0.5) * w, y: (-overlayProject.y * 0.5 + 0.5) * h, visible };
  }

  function placeOverlayEl(el: HTMLElement, x: number, y: number, z: number, anchor: 'pin' | 'label') {
    const p = projectMapPoint(x, y, z);
    if (!p.visible) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.transform = anchor === 'label' ? 'translate(-50%, 4px)' : 'translate(-50%, -100%)';
  }

  function resolveRouteEndpoint(id: string): { x: number; y: number; z: number; name: string } | null {
    if (!id) return null;
    const from2d = floor2dView?.resolveRouteEndpoint(id, floorSliceY);
    if (from2d) return from2d;
    const poi = findNavMapPoi(id);
    if (poi) return { x: poi.x, y: poi.y, z: poi.z, name: poi.name };
    return null;
  }

  function getRouteZonesForSelect() {
    return floor2dView?.getRouteZones() ?? [];
  }

  function getRouteFloorsForSelect() {
    return floor2dView?.getRouteFloors() ?? [];
  }

  /** POIs for origin/destination dropdowns — filtered by active floor or all when viewing every floor. */
  function getPoisForRouteUi(): ReturnType<typeof getNavMapPois> {
    const all = getNavMapPois();
    if (!use2d || !floor2dView) return all;
    return floor2dView.poisForDisplay(getNavMapPois());
  }

  /** POIs shown on the map for the active floor selection. */
  function getPoisForActiveFloor(): ReturnType<typeof getNavMapPois> {
    if (!use2d || !floor2dView) return getNavMapPois();
    return floor2dView.poisForDisplay(getNavMapPois());
  }

  function syncFloor2dPoiDisplay() {
    if (!use2d || !floor2dView || !originSelect || !destSelect) return;
    floor2dView.setPois(getNavMapPois(), originSelect.value, destSelect.value);
    floor2dView.draw();
  }

  function updateMapOverlayPositions() {
    if (!mapOverlayLayer || fsOverlay?.style.display !== 'flex') return;
    const overlayPois = use2d ? getPoisForActiveFloor() : getNavMapPois();
    for (const poi of overlayPois) {
      const label = poiLabelEls.get(poi.id);
      if (label) placeOverlayEl(label, poi.x, poi.y + 0.32, poi.z, 'label');
    }
    if (originPinEl && originSelect?.value) {
      const o = resolveRouteEndpoint(originSelect.value);
      if (o) {
        originPinEl.classList.remove('mini3dgta-route-pin--hidden');
        placeOverlayEl(originPinEl, o.x, o.y + 0.35, o.z, 'pin');
      } else originPinEl.classList.add('mini3dgta-route-pin--hidden');
    }
    if (destPinEl && destSelect?.value) {
      const d = resolveRouteEndpoint(destSelect.value);
      if (d) {
        destPinEl.classList.remove('mini3dgta-route-pin--hidden');
        placeOverlayEl(destPinEl, d.x, d.y + 0.35, d.z, 'pin');
      } else destPinEl.classList.add('mini3dgta-route-pin--hidden');
    }
  }

  function rebuildMapOverlay() {
    if (!mapOverlayLayer) return;
    mapOverlayLayer.innerHTML = '';
    poiLabelEls.clear();
    originPinEl = null;
    destPinEl = null;
    const overlayPois = use2d ? getPoisForActiveFloor() : getNavMapPois();
    for (const poi of overlayPois) {
      const label = document.createElement('span');
      label.className = 'mini3dgta-poi-label';
      label.textContent = poi.name;
      label.title = poi.name;
      mapOverlayLayer.appendChild(label);
      poiLabelEls.set(poi.id, label);
    }
    if (originSelect?.value) {
      originPinEl = document.createElement('div');
      originPinEl.className = 'mini3dgta-route-pin';
      originPinEl.innerHTML = POI_PIN_SVG_ORIGIN;
      mapOverlayLayer.appendChild(originPinEl);
    }
    if (destSelect?.value) {
      destPinEl = document.createElement('div');
      destPinEl.className = 'mini3dgta-route-pin';
      destPinEl.innerHTML = POI_PIN_SVG_DEST;
      mapOverlayLayer.appendChild(destPinEl);
    }
    updateMapOverlayPositions();
  }

  function refreshPoiSelects() {
    if (!originSelect || !destSelect) return;
    const pois = getPoisForRouteUi();
    const zones = getRouteZonesForSelect();
    const floors = getRouteFloorsForSelect();
    const floorLevels = floor2dView?.getFloorLevels() ?? [];
    const o = originSelect.value;
    const d = destSelect.value;
    fillRouteEndpointSelect(
      originSelect,
      'Choose origin…',
      pois,
      zones,
      floors,
      d || undefined,
      o,
      floorLevels,
    );
    fillRouteEndpointSelect(
      destSelect,
      'Choose destination…',
      pois,
      zones,
      floors,
      o || undefined,
      d,
      floorLevels,
    );
    syncFloor2dPoiDisplay();
    applyPoiSelectionsFn?.();
  }

  function syncPoiSelectionsToRoute() {
    if (!originSelect || !destSelect) return;
    const pois = getPoisForActiveFloor();
    if (!originSelect.value && pois.length > 0) originSelect.value = pois[0].id;
    if (!destSelect.value && pois.length > 1) {
      const second = pois[1].id !== originSelect.value ? pois[1] : pois.length > 2 ? pois[2] : null;
      if (second) destSelect.value = second.id;
    }
    refreshPoiSelects();
  }

  function attachRoute() {
    if (use2d) {
      rebuildFloor2dRoute();
      return;
    }
    if (routeHandle) {
      scene.remove(routeHandle.group);
      routeHandle.dispose();
      routeHandle = null;
    }
    routeHandle = createRouteAndBreadcrumbs(() => getNavMesh(), {
      hideSphereMarkers: true,
    });
    syncPoiSelectionsToRoute();
    scene.add(routeHandle.group);
  }

  let routeRebuildRaf = 0;

  function scheduleRebuildFloor2dRoute(): void {
    if (!use2d) return;
    if (routeRebuildRaf) cancelAnimationFrame(routeRebuildRaf);
    routeRebuildRaf = requestAnimationFrame(() => {
      routeRebuildRaf = 0;
      rebuildFloor2dRoute();
    });
  }

  function rebuildFloor2dRoute(): { valid: boolean; error: string | null } {
    if (!use2d || !floor2dView || !originSelect || !destSelect) {
      floor2dView?.setPath([]);
      return { valid: false, error: null };
    }
    const o = originSelect.value ? resolveRouteEndpoint(originSelect.value) : null;
    const d = destSelect.value ? resolveRouteEndpoint(destSelect.value) : null;
    if (!o || !d) {
      floor2dView.setPath([]);
      syncFloor2dPoiDisplay();
      return { valid: false, error: null };
    }
    floor2dView.flushCurrentFloorState();
    const result = floor2dView.computeAndSetRoute(getNavMesh(), o, d);
    syncFloor2dPoiDisplay();
    return { valid: result.valid, error: result.error ?? null };
  }

  function updatePaintFloorTitle() {
    paintFloorBtn.title = `Drag to paint walkable floor at Y = ${floorSliceY}`;
  }
  updatePaintFloorTitle();

  function ensureFloor2dView(): Floor2DView {
    if (!floor2dView) {
      floor2dView = new Floor2DView(mountRoot);
      floor2dView.setOnToolChange((tool: Floor2DTool) => {
        panBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'pan');
        if (tool !== 'pan') {
          walls3dBtn.classList.remove('mini3dgta-fs-tool--active');
        } else if (floor2dView?.isIso3d()) {
          walls3dBtn.classList.add('mini3dgta-fs-tool--active');
        }
        paintFloorBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'add');
        cutBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'cut');
        objectBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'object');
        zoneBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'zone');
        editZoneBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'zone-edit');
        shapeBar.style.display = tool === 'object' ? 'inline-flex' : 'none';
        zoneShapeBar.style.display = tool === 'zone' ? 'inline-flex' : 'none';
        deleteZoneBtn.style.display = tool === 'zone-edit' ? 'inline-block' : 'none';
        if (tool !== 'zone-edit') deleteZoneBtn.disabled = true;
        updatePaintFloorTitle();
      });
      floor2dView.setOnFloorActivate((floor) => {
        switchToFloorLevel(floor.floorY, floor.id);
        refreshPoiSelects();
      });
      floor2dView.setOnZoneSelectionChange((zoneId) => {
        deleteZoneBtn.disabled = !zoneId;
      });
      floor2dView.setOnDirtyChange(() => {
        saveBtn.disabled = !floor2dView?.hasMap() || saveInFlight;
      });
      floor2dView.setOnHistoryChange((canUndo, canRedo) => {
        undoBtn.disabled = !canUndo;
        redoBtn.disabled = !canRedo;
      });
      floor2dView.setOnZonesChange(() => {
        refreshPoiSelects();
        applyPoiSelectionsFn?.();
      });
      floor2dView.setOnFloorsChange(() => {
        floor2dView?.fit();
        refreshPoiSelects();
        applyPoiSelectionsFn?.();
        floor2dView?.draw();
      });
      floor2dView.setOnViewStackChange(() => {
        walls3dBtn.classList.toggle('mini3dgta-fs-tool--active', floor2dView?.isIso3d() ?? false);
        refreshPoiSelects();
      });
      floor2dView.setOnIso3dChange((on) => {
        walls3dBtn.classList.toggle('mini3dgta-fs-tool--active', on);
      });
      floor2dView.setOnRouteRebuild(() => {
        applyPoiSelectionsFn?.();
      });
    }
    return floor2dView;
  }

  function refreshNavMeshOverlay() {
    if (!use2d || !floor2dView?.isNavMeshVisible()) return;
    floor2dView.refreshNavMeshOverlay(getNavMesh(), floorSliceY);
  }

  function show2dFloorFromMesh(
    options: {
      preserveFloors?: boolean;
      activeFloorId?: string | null;
      forceLoadSaved?: boolean;
    } = {},
  ) {
    if (!use2d || mapRoot.children.length === 0) return;
    const view = ensureFloor2dView();
    const hasMemoryFloors = view.getFloorLevels().length > 0;
    const preserveFloors = options.preserveFloors ?? hasMemoryFloors;
    if (preserveFloors && hasMemoryFloors) view.flushCurrentFloorState();

    const base = buildFloor2DFromMap(mapRoot, floorSliceY);
    const savedEdit =
      pendingFloorEdit?.floor_data &&
      pendingFloorEdit.map_code === activeMapCode.trim().toUpperCase()
        ? pendingFloorEdit
        : null;
    const shouldApplySaved =
      savedEdit != null && (options.forceLoadSaved === true || !preserveFloors);
    let map = shouldApplySaved
      ? applySavedFloorEditToMap(base, savedEdit.floor_data)
      : base;
    if (preserveFloors && hasMemoryFloors) {
      map = { ...map, floors: view.getFloorLevels() };
    }
    view.setMap(map, {
      preserveFloors,
      activeFloorId:
        options.activeFloorId !== undefined ? options.activeFloorId : view.getActiveFloorId(),
    });
    deleteFloorBtn.disabled = !view.getActiveFloorId();
    renameFloorBtn.disabled = !view.getActiveFloorId();
    refreshPoiSelects();
    saveBtn.disabled = saveInFlight;
    refreshNavMeshOverlay();
    syncFloor2dRouteFn?.();
  }

  function switchToFloorLevel(floorY: number, activeFloorId: string | null) {
    floorSliceY = floorY;
    sliceInput.value = String(floorSliceY);
    updatePaintFloorTitle();
    pendingFloorEdit = null;
    show2dFloorFromMesh({ preserveFloors: true, activeFloorId });
  }

  async function loadFloorEditForProject(poiType: string, mapCode: string): Promise<void> {
    floor2dView?.clearFloorLevels();
    pendingFloorEdit = await fetchNavmeFloorEdit(poiType, mapCode);
    if (pendingFloorEdit) {
      floorSliceY = pendingFloorEdit.floor_slice_y;
      sliceInput.value = String(floorSliceY);
      console.log(
        `[Mini3dGta] Loaded floor edit for ${poiType} / ${mapCode} (slice Y=${floorSliceY}, ${pendingFloorEdit.floor_data.objects.length} objects, ${pendingFloorEdit.floor_data.zones.length} zones, ${pendingFloorEdit.floor_data.floors.length} floors)`,
      );
    } else {
      console.log(`[Mini3dGta] No saved floor edit for ${poiType} / ${mapCode}`);
    }
  }

  async function runStructureAnalyze() {
    if (!use2d || mapRoot.children.length === 0) return;
    const gen = ++floorAnalyzeGen;
    analyzeBtn.disabled = true;
    setNotify('Analyze', 'Python structure analysis…', 'loading');
    try {
      await fetchAnalyzedFloorPlanFromMap(mapRoot, floorSliceY);
      if (gen !== floorAnalyzeGen) return;
      show2dFloorFromMesh({ preserveFloors: true, activeFloorId: floor2dView?.getActiveFloorId() ?? null });
      setNotify('Ready', 'Floor map ready — Add/Cut/Object, then Save', 'done');
    } catch (err) {
      setNotify('Analyze', err instanceof Error ? err.message : String(err), 'error');
    } finally {
      analyzeBtn.disabled = false;
    }
  }

  function syncFloor2dRoute() {
    if (!use2d || !floor2dView) return;
    rebuildFloor2dRoute();
  }
  syncFloor2dRouteFn = syncFloor2dRoute;

  function resize() {
    const w = Math.max(1, viewport.clientWidth);
    const h = Math.max(1, viewport.clientHeight);
    if (use2d) {
      floor2dView?.resize();
      return;
    }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  const ro = new ResizeObserver(() => resize());
  ro.observe(viewport);
  resize();
  resizeViewportFn = resize;
  rebuildMapOverlayFn = rebuildMapOverlay;

  let raf = 0;
  let disposed = false;
  function tick() {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    if (!use2d) {
      controls.update();
      if (fsOverlay?.style.display === 'flex') updateMapOverlayPositions();
      renderer.render(scene, camera);
    }
  }
  tick();

  const { loader: gltfLoader, draco: dracoLoader } = createGltfLoaderWithDraco();
  let activePoiType = getPoiTypeFromUrl();
  let activeClientId = getCreds(cfg).clientId;
  let activeClientSecret = getCreds(cfg).clientSecret;
  let activeMapCode = getCreds(cfg).mapCode;
  mapCodeInput.value = activeMapCode;
  let projectReady: Promise<void> = Promise.resolve();

  async function refreshPoisForProject() {
    const pois = await fetchNavmePoisByPoiType(activePoiType);
    if (pois.length > 0) {
      setNavMapPois(pois);
    } else if (mapRoot.children.length > 0) {
      setNavMapPois(buildDemoPoisFromMap(mapRoot));
    } else {
      setNavMapPois([]);
    }
    refreshPoiSelects();
    rebuildMapOverlayFn?.();
    syncFloor2dRouteFn?.();
  }

  async function applyNavmeProject(poiType: string, reloadMapAfter = false) {
    activePoiType = poiType;
    const project = await resolveNavmeProject(poiType);
    activeClientId = project.clientId;
    activeClientSecret = project.clientSecret;
    activeMapCode = project.mapCode;
    mapCodeInput.value = activeMapCode;
    await loadFloorEditForProject(poiType, activeMapCode);
    await refreshPoisForProject();
    if (reloadMapAfter) reloadMap();
    else if (use2d && mapRoot.children.length > 0) {
      show2dFloorFromMesh({ forceLoadSaved: true });
    }
  }

  projectReady = (async () => {
    if (!isSupabaseConfigured()) {
      console.warn('[Mini3dGta] Supabase not configured — using defaults. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
      poiTypeSelect.replaceChildren();
      const opt = document.createElement('option');
      opt.value = activePoiType;
      opt.textContent = activePoiType;
      poiTypeSelect.appendChild(opt);
      return;
    }
    const types = await fetchNavmeLoginTypes();
    poiTypeSelect.replaceChildren();
    const list = types.length > 0 ? types : [activePoiType];
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      poiTypeSelect.appendChild(opt);
    }
    const match =
      list.find((t) => t.trim().toLowerCase() === activePoiType.trim().toLowerCase()) || list[0];
    poiTypeSelect.value = match;
    await applyNavmeProject(match);
  })();

  let mapPipelinePromise: Promise<void> | null = null;
  let mapPipelineRunning = false;
  const runMapPipeline = (): Promise<void> => {
    if (mapPipelinePromise) return mapPipelinePromise;
    const mapCode = activeMapCode.trim();
    mapPipelinePromise = (async () => {
      await projectReady;
      mapPipelineRunning = true;
      refreshBtn.disabled = true;
      const LOG = '[Mini3dGta]';
      clearNavMesh();
      disposeMapChildren(mapRoot);
      if (routeHandle) {
        scene.remove(routeHandle.group);
        routeHandle.dispose();
        routeHandle = null;
      }
      setNotify('Starting', `Loading ${mapCode}…`, 'loading');
      try {
        const apiBase = resolveMultiSetApiBase(cfg);
        if (apiBase === MULTISET_PUBLIC_API) {
          console.warn(`${LOG} Direct api.multiset.ai may fail in browser — use proxy`);
        }
        const ms = buildMultiSetEndpoints(cfg);
        const glbProxy = resolveGlbCorsProxyPostUrl(cfg, apiBase);
        setNotify('Loading', 'Loading map…', 'loading');
        const { token } = await getM2MTokenCached(activeClientId, activeClientSecret, ms.tokenUrl);
        const glbBuffer = await downloadMapMesh(token, mapCode, ms, glbProxy, {
          preferSmallerMesh: use2d,
        });
        if (!glbBuffer) {
          setNotify('Stopped', 'No GLB found for this map code.', 'error');
          return;
        }
        setNotify('Parse', 'Parsing GLB…', 'loading');
        const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
          gltfLoader.parse(glbBuffer, '', resolve, reject);
        });
        gltf.scene.name = 'MapMeshRoot';
        mapRoot.add(gltf.scene);
        mapRoot.updateMatrixWorld(true);
        fitCameraToMap();
        await refreshPoisForProject();
        rebuildMapOverlay();
        if (use2d) {
          show2dFloorFromMesh({ forceLoadSaved: true });
        }
        setNotify('Ready', use2d ? '2D floor map — Add/Cut/Object, then Save' : 'Map visible — preparing navigation…', 'done');
        await yieldToBrowser();
        if (!use2d) requestAnimationFrame(() => applyMapTransparentGhostMaterial(gltf.scene));

        const finishNavAndRoute = async () => {
          if (use2d) {
            navMeshBuilding = true;
            navMeshBtn.disabled = true;
            setNotify('Nav mesh', 'Building walkable nav mesh…', 'loading');
            try {
              clearStairPortalCache();
              const navResult = await ensureNavMeshForMap(mapRoot);
              if (!navResult.success) {
                setNotify('Nav mesh failed', navResult.error || 'Unknown error', 'error');
              }
              refreshNavMeshOverlay();
            } catch (err) {
              console.warn('[navmesh] build failed:', err);
              setNotify('Nav mesh failed', err instanceof Error ? err.message : String(err), 'error');
            } finally {
              navMeshBuilding = false;
              navMeshBtn.disabled = false;
            }
            attachRoute();
            const route = rebuildFloor2dRoute();
            const hasRouteEndpoints = Boolean(originSelect?.value && destSelect?.value);
            if (hasRouteEndpoints && !route.valid) {
              setNotify('Path', route.error || 'Could not build path on nav mesh', 'error');
              return;
            }
            setNotify('Ready', 'Floor navigation ready (nav mesh route)', 'done');
            return;
          }

          navMeshBuilding = true;
          navMeshBtn.disabled = true;
          setNotify('Nav mesh', 'Building walkable nav mesh…', 'loading');
          try {
            const navResult = await ensureNavMeshForMap(mapRoot);
            if (!navResult.success) {
              setNotify('Nav mesh failed', navResult.error || 'Unknown error', 'error');
              return;
            }
            attachRoute();
            syncFloor2dRouteFn?.();
            refreshNavMeshOverlay();
            const hasRouteEndpoints = Boolean(originSelect?.value && destSelect?.value);
            if (hasRouteEndpoints && !routeHandle?.state.valid) {
              setNotify('Path', routeHandle?.state.error || 'Could not build path', 'error');
              return;
            }
            setNotify('Ready', `Navigation ready (${(navResult.durationMs / 1000).toFixed(1)}s)`, 'done');
          } catch (err) {
            console.error('[navmesh]', err);
            setNotify('Nav mesh failed', err instanceof Error ? err.message : String(err), 'error');
          } finally {
            navMeshBuilding = false;
            navMeshBtn.disabled = false;
          }
        };

        if (DEFER_NAV_MESH) void finishNavAndRoute();
        else {
          setNotify('Nav mesh', 'Building walkable nav mesh…', 'loading');
          await finishNavAndRoute();
        }
      } catch (err) {
        console.error(LOG, err);
        setNotify('Error', err instanceof Error ? err.message : String(err), 'error');
      } finally {
        mapPipelineRunning = false;
        refreshBtn.disabled = false;
        mapPipelinePromise = null;
      }
    })();
    return mapPipelinePromise;
  };

  const reloadMap = () => {
    const next = mapCodeInput.value.trim().toUpperCase();
    if (!next || mapPipelineRunning) return;
    activeMapCode = next;
    mapCodeInput.value = next;
    mapPipelinePromise = null;
    if (use2d) floor2dView?.setPath([]);
    void loadFloorEditForProject(activePoiType, activeMapCode).then(() => runMapPipeline());
  };

  refreshBtn.addEventListener('click', reloadMap);
  mapCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') reloadMap();
  });
  poiTypeSelect.addEventListener('change', () => {
    void applyNavmeProject(poiTypeSelect.value, true);
  });

  const setFullscreenOpen = (open: boolean) => {
    if (!fsOverlay) return;
    fsOverlay.style.display = open ? 'flex' : 'none';
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggleBtn.classList.toggle('mini3dgta-map-toggle--hidden', open);
    }
    if (open) {
      if (!viewport.contains(uiCanvas)) viewport.appendChild(uiCanvas);
      resizeViewportFn?.();
      rebuildMapOverlayFn?.();
      if (deferHeavy) void runMapPipeline();
    }
  };
  setFullscreenOpenFn = setFullscreenOpen;

  if (toggleBtn) toggleBtn.addEventListener('click', () => setFullscreenOpen(fsOverlay!.style.display !== 'flex'));
  closeBtn.addEventListener('click', () => setFullscreenOpen(false));

  applyPoiSelectionsFn = () => {
    if (!originSelect || !destSelect) return;
    if (use2d) {
      scheduleRebuildFloor2dRoute();
    } else if (routeHandle) {
      const o = originSelect.value ? resolveRouteEndpoint(originSelect.value) : null;
      const d = destSelect.value ? resolveRouteEndpoint(destSelect.value) : null;
      if (o) routeHandle.setOrigin(o.x, o.y, o.z);
      if (d) routeHandle.setDestination(d.x, d.y, d.z);
    }
    rebuildMapOverlayFn?.();
    syncFloor2dRouteFn?.();
  };

  const scheduleSliceRebuild = () => {
    if (sliceDebounceTimer) clearTimeout(sliceDebounceTimer);
    sliceDebounceTimer = setTimeout(
      () =>
        show2dFloorFromMesh({
          preserveFloors: true,
          activeFloorId: floor2dView?.getActiveFloorId() ?? null,
        }),
      450,
    );
  };

  analyzeBtn.addEventListener('click', () => void runStructureAnalyze());
  paintFloorBtn.addEventListener('click', () => ensureFloor2dView().setTool('add'));
  floorBtn.addEventListener('click', () => {
    const view = ensureFloor2dView();
    const floor = view.addFloorLevel(floorSliceY);
    switchToFloorLevel(floor.floorY, floor.id);
  });
  renameFloorBtn.addEventListener('click', () => {
    void ensureFloor2dView().renameActiveFloor();
  });
  deleteFloorBtn.addEventListener('click', () => {
    if (floor2dView?.deleteActiveFloor()) {
      const active = floor2dView.getActiveFloor();
      if (active) switchToFloorLevel(active.floorY, active.id);
      else show2dFloorFromMesh({ preserveFloors: true, activeFloorId: null });
      deleteFloorBtn.disabled = !floor2dView.getActiveFloorId();
    }
  });
  cutBtn.addEventListener('click', () => ensureFloor2dView().setTool('cut'));
  objectBtn.addEventListener('click', () => ensureFloor2dView().setTool('object'));
  zoneBtn.addEventListener('click', () => ensureFloor2dView().setTool('zone'));
  editZoneBtn.addEventListener('click', () => ensureFloor2dView().setTool('zone-edit'));
  deleteZoneBtn.addEventListener('click', () => {
    floor2dView?.deleteSelectedZone();
  });
  const setZoneDrawMode = (mode: ZoneDrawMode) => {
    const view = ensureFloor2dView();
    view.setZoneDrawMode(mode);
    zoneRectBtn.classList.toggle('mini3dgta-fs-shape--active', mode === 'rectangle');
    zonePolyBtn.classList.toggle('mini3dgta-fs-shape--active', mode === 'polygon');
  };
  zoneRectBtn.addEventListener('click', () => setZoneDrawMode('rectangle'));
  zonePolyBtn.addEventListener('click', () => setZoneDrawMode('polygon'));
  rectShapeBtn.addEventListener('click', () => {
    const view = ensureFloor2dView();
    view.setObjectShape('rectangle');
    rectShapeBtn.classList.add('mini3dgta-fs-shape--active');
    circleShapeBtn.classList.remove('mini3dgta-fs-shape--active');
  });
  circleShapeBtn.addEventListener('click', () => {
    const view = ensureFloor2dView();
    view.setObjectShape('circle');
    circleShapeBtn.classList.add('mini3dgta-fs-shape--active');
    rectShapeBtn.classList.remove('mini3dgta-fs-shape--active');
  });
  navMeshBtn.addEventListener('click', () => {
    const view = ensureFloor2dView();
    const next = !view.isNavMeshVisible();
    if (next && navMeshBuilding) {
      setNotify('NavMesh', 'Nav mesh is still building — please wait…', 'loading');
      return;
    }
    if (next && !isNavMeshReady()) {
      setNotify('NavMesh', 'Nav mesh unavailable — check for build errors above', 'error');
      return;
    }
    view.setNavMeshVisible(next, getNavMesh(), floorSliceY);
    navMeshBtn.classList.toggle('mini3dgta-fs-tool--active', next);
  });
  undoBtn.addEventListener('click', () => floor2dView?.undo());
  redoBtn.addEventListener('click', () => floor2dView?.redo());
  panBtn.addEventListener('click', () => ensureFloor2dView().setTool('pan'));
  walls3dBtn.addEventListener('click', () => {
    const view = ensureFloor2dView();
    const on = view.toggleIso3d();
    walls3dBtn.classList.toggle('mini3dgta-fs-tool--active', on);
    if (on) {
      view.setTool('pan');
      panBtn.classList.add('mini3dgta-fs-tool--active');
    }
  });
  saveBtn.addEventListener('click', () => {
    void (async () => {
      const view = floor2dView;
      if (!view?.hasMap()) return;
      if (view.isDirty()) view.saveEdits();
      const state = view.getEditStateForSave();
      const payload = view.exportEditPayload(floorSliceY, activeMapCode);
      if (!state || !payload) {
        setNotify('Save', 'Nothing to save yet', 'error');
        return;
      }
      saveInFlight = true;
      saveBtn.disabled = true;
      setNotify('Saving', 'Writing floor map to database…', 'loading');
      const result = await saveNavmeFloorEdit(
        activePoiType,
        activeMapCode,
        floorSliceY,
        state.map,
        state.walk,
        state.objects,
        state.zones,
        state.floors,
      );
      saveInFlight = false;
      saveBtn.disabled = !view.hasMap();
      if (result.ok) {
        pendingFloorEdit = {
          poi_type: activePoiType,
          map_code: activeMapCode.trim().toUpperCase(),
          floor_slice_y: floorSliceY,
          floor_data: payload,
        };
        setNotify(
          'Saved',
          `Floor map saved (${payload.objects.length} object(s), ${payload.floors.length} floor(s), ${payload.zones.length} zone(s), Y=${floorSliceY})`,
          'done',
        );
      } else {
        setNotify('Save failed', result.error || 'Could not write to database', 'error');
      }
    })();
  });
  const onFloorEditKeydown = (e: KeyboardEvent) => {
    if (!use2d || fsOverlay?.style.display !== 'flex' || !floor2dView) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.key.toLowerCase() !== 'z') return;
    e.preventDefault();
    if (e.shiftKey) floor2dView.redo();
    else floor2dView.undo();
  };
  window.addEventListener('keydown', onFloorEditKeydown);

  function applySliceYChange(newY: number) {
    if (!Number.isFinite(newY)) return;
    const view = floor2dView;
    const prevY = floorSliceY;
    const active = view?.getActiveFloor();
    if (view && active && Math.abs(active.floorY - prevY) < 1e-4) {
      view.flushCurrentFloorState();
    }
    floorSliceY = newY;
    sliceInput.value = String(floorSliceY);
    updatePaintFloorTitle();
    pendingFloorEdit = null;

    const existing = view?.getFloorLevels().find((f) => Math.abs(f.floorY - newY) < 1e-4);
    if (existing) {
      switchToFloorLevel(existing.floorY, existing.id);
      return;
    }

    view?.clearActiveFloor();
    if (sliceDebounceTimer) clearTimeout(sliceDebounceTimer);
    show2dFloorFromMesh({ preserveFloors: true, activeFloorId: null });
    refreshNavMeshOverlay();
  }

  sliceInput.addEventListener('change', () => {
    applySliceYChange(parseFloat(sliceInput.value));
  });

  originSelect.addEventListener('change', () => {
    if (destSelect && originSelect && destSelect.value === originSelect.value) destSelect.value = '';
    refreshPoiSelects();
    applyPoiSelectionsFn?.();
  });
  destSelect.addEventListener('change', () => {
    if (originSelect && destSelect && originSelect.value === destSelect.value) originSelect.value = '';
    refreshPoiSelects();
    applyPoiSelectionsFn?.();
  });

  const ready = deferHeavy ? Promise.resolve() : runMapPipeline();

  if (autoStart) {
    queueMicrotask(() => setFullscreenOpen(true));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    renderer.dispose();
    dracoLoader.dispose();
    if (routeHandle) {
      scene.remove(routeHandle.group);
      routeHandle.dispose();
      routeHandle = null;
    }
    clearNavMesh();
    disposeMapChildren(mapRoot);
    mapOverlayLayer?.replaceChildren();
    poiLabelEls.clear();
    if (sliceDebounceTimer) clearTimeout(sliceDebounceTimer);
    window.removeEventListener('keydown', onFloorEditKeydown);
    floor2dView?.dispose();
    floor2dView = null;
    toggleBtn?.remove();
    fsOverlay?.remove();
  }

  return {
    rootElement: mountRoot,
    ready,
    openFullscreen: () => setFullscreenOpenFn?.(true),
    closeFullscreen: () => setFullscreenOpenFn?.(false),
    setOrigin(x, y, z) {
      routeHandle?.setOrigin(x, y, z);
    },
    setDestination(x, y, z) {
      routeHandle?.setDestination(x, y, z);
    },
    rebuildRoute: () => routeHandle?.rebuild(),
    getRouteState: () => routeHandle?.state ?? null,
    dispose,
  };
}

export { createMini3dGtaMapButton };
