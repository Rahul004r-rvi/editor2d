import type { NavMesh } from 'recast-navigation';
import {
  filterPoisByFloorY,
  findNavMapPoi,
  nearestFloorYForPoi,
  parseFloorRouteId,
  parseZoneRouteId,
  type NavMapPoi,
} from './pois';
import {
  applyRegionEdit,
  cloneRegionBlock,
  hitRegionHandle,
  hitTestRegion,
  regionCentroid,
  type RegionDrawMode,
} from './labeledRegion';
import { buildFloorEditPayload, type NavmeFloorEditPayload } from './data/floorEditPayload';
import {
  applyWalkGridEdits,
  cloneFloorLevels,
  defaultFloorLabel,
  floorLevelGridMatches,
  floorLevelSliceMatches,
  FLOOR2D_STYLE,
  nextZoneStrokeColor,
  paintRectOnWalk,
  walkGridFromBlocks,
  zoneDisplayLabel,
  type Floor2DMap,
  type FloorBlock,
  type FloorLevel,
  type FloorShape,
} from './floor2d';
import { findPathOnFloorGrid, type FloorPathPoint } from './floor2dRoute';
import {
  computeMultiFloorRoute,
  getFloorWalkGrid,
  previewMapForFloor,
  type FloorRouteConnector,
  type FloorRouteSegment,
  type RouteBreakPoint,
} from './floor2dMultiRoute';
import { Floor2DScene3d } from './floor2dScene3d';
import { extractNavMeshSlice2D, type NavMeshSliceTri } from './navmesh2d';
import {
  boundsFromPoints,
  dist2,
  isPolygonZone,
  syncZoneBounds,
  zoneCentroid,
  type ZoneEditHandle,
  type ZonePoint,
} from './zoneGeometry';

export type Floor2DViewOptions = {
  onPoiClick?: (poi: NavMapPoi) => void;
};

export type Floor2DTool = 'pan' | 'add' | 'cut' | 'object' | 'zone' | 'zone-edit';
export type ZoneDrawMode = RegionDrawMode;

type EditSnapshot = { walk: Uint8Array; objects: FloorBlock[]; zones: FloorBlock[] };

const MIN_BLOCK = 0.1;
const MAX_HISTORY = 50;
const HANDLE_RADIUS_PX = 9;
const CLOSE_POLY_DIST_PX = 14;

function normRect(x0: number, z0: number, x1: number, z1: number): FloorBlock {
  const x = Math.min(x0, x1);
  const z = Math.min(z0, z1);
  return {
    id: '',
    x,
    z,
    w: Math.abs(x1 - x0),
    d: Math.abs(z1 - z0),
    fill: FLOOR2D_STYLE.corridor,
    label: '',
  };
}

function cloneBlocks(blocks: FloorBlock[]): FloorBlock[] {
  return blocks.map((o) => ({
    ...o,
    points: o.points?.map((p) => ({ x: p.x, z: p.z })),
  }));
}

function truncateLabel(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

export class Floor2DView {
  readonly canvas: HTMLCanvasElement;
  private scene3d: Floor2DScene3d | null = null;
  private iso3d = false;
  private multiFloor3dAuto = false;
  /** Multi-floor 3D stacked plates (View Stack); off = single-floor 2D paper. */
  private viewStack = false;
  private map: Floor2DMap | null = null;
  private editWalk: Uint8Array | null = null;
  private editObjects: FloorBlock[] = [];
  private editZones: FloorBlock[] = [];
  private editFloors: FloorLevel[] = [];
  private activeFloorId: string | null = null;
  private objectShape: FloorShape = 'rectangle';
  private tool: Floor2DTool = 'pan';
  private dirty = false;
  private draft: { x0: number; z0: number; x1: number; z1: number } | null = null;
  private path: { x: number; z: number }[] = [];
  private routeSegments: FloorRouteSegment[] = [];
  private routeConnectors: FloorRouteConnector[] = [];
  private routeError: string | null = null;
  private routeDebugForward: FloorRouteSegment[] = [];
  private routeDebugReverse: FloorRouteSegment[] = [];
  private routeBreakPoints: RouteBreakPoint[] = [];
  private pois: NavMapPoi[] = [];
  private originId = '';
  private destId = '';
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private objectIdSeq = 0;
  private zoneIdSeq = 0;
  private floorIdSeq = 0;
  private undoStack: EditSnapshot[] = [];
  private redoStack: EditSnapshot[] = [];
  private showNavMesh = false;
  private navMeshTris: NavMeshSliceTri[] = [];
  private onToolChange?: (tool: Floor2DTool) => void;
  private onDirtyChange?: (dirty: boolean) => void;
  private onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
  private onZonesChange?: () => void;
  private onFloorsChange?: () => void;
  private onRouteRebuild?: () => void;
  private onIso3dChange?: (on: boolean) => void;
  private onZoneSelectionChange?: (zoneId: string | null) => void;
  private onFloorActivate?: (floor: FloorLevel) => void;
  private onViewStackChange?: (on: boolean) => void;
  private zoneDialog: HTMLDivElement | null = null;
  private zoneNameInput: HTMLInputElement | null = null;
  private zoneDialogResolve: ((name: string | null) => void) | null = null;
  private zoneSidebar: HTMLElement | null = null;
  private zoneListEl: HTMLElement | null = null;
  private floorListEl: HTMLElement | null = null;
  private zoneDrawMode: ZoneDrawMode = 'rectangle';
  private selectedZoneId: string | null = null;
  private polygonDraft: { points: ZonePoint[]; cursorX: number; cursorZ: number } | null = null;
  private zoneEdit: {
    block: FloorBlock;
    handle: ZoneEditHandle;
    startWorld: { x: number; z: number };
    snapshot: FloorBlock;
    historyPushed: boolean;
  } | null = null;
  constructor(parent: HTMLElement, _options: Floor2DViewOptions = {}) {
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    this.buildZoneSidebar(parent);
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'display:block;width:100%;height:100%;touch-action:none;cursor:grab;background:' +
      FLOOR2D_STYLE.background +
      ';position:relative;z-index:1;';
    parent.appendChild(this.canvas);
    this.scene3d = new Floor2DScene3d(parent);
    this.buildZoneNameDialog(parent);
    this.bindPointer();
    this.bindKeyboard();
  }

  isIso3d(): boolean {
    return this.iso3d;
  }

  private scene3dWanted(): boolean {
    return this.iso3d || this.viewStack;
  }

  private updateScene3dVisibility(): void {
    const show = this.scene3dWanted();
    this.scene3d?.setVisible(show);
    this.canvas.style.display = show ? 'none' : 'block';
  }

  /** Toggle extruded 3D walls with orbit / tilt (drag to rotate view). */
  toggleIso3d(): boolean {
    this.iso3d = !this.iso3d;
    this.updateScene3dVisibility();
    if (this.scene3dWanted()) {
      this.syncScene3d(true);
    } else {
      this.draw();
    }
    this.onIso3dChange?.(this.iso3d);
    return this.iso3d;
  }

  isMultiFloor3dAuto(): boolean {
    return this.multiFloor3dAuto;
  }

  setOnIso3dChange(cb: (on: boolean) => void): void {
    this.onIso3dChange = cb;
  }

  private enableMultiFloor3dView(): void {
    if (!this.scene3d || !this.map) return;
    this.multiFloor3dAuto = true;
    this.updateScene3dVisibility();
  }

  private usesStackedPlate3d(): boolean {
    return this.viewStack && this.usesStackedLayout() && this.tool === 'pan';
  }

  isViewStack(): boolean {
    return this.viewStack;
  }

  toggleViewStack(): boolean {
    if (!this.usesStackedLayout()) {
      this.viewStack = false;
      return false;
    }
    this.viewStack = !this.viewStack;
    if (this.viewStack) {
      this.tool = 'pan';
      this.canvas.style.cursor = 'grab';
      this.onToolChange?.('pan');
      this.enableMultiFloor3dView();
      this.syncScene3d(true);
    } else {
      this.disableMultiFloor3dView();
      this.fit();
      if (this.iso3d) this.syncScene3d(true);
      else this.draw();
    }
    this.onViewStackChange?.(this.viewStack);
    this.refreshFloorSidebar();
    return this.viewStack;
  }

  setViewStack(on: boolean): void {
    if (on === this.viewStack) return;
    if (on && !this.usesStackedLayout()) return;
    if (on) this.toggleViewStack();
    else if (this.viewStack) this.toggleViewStack();
  }

  private disableMultiFloor3dView(): void {
    if (!this.multiFloor3dAuto) return;
    this.multiFloor3dAuto = false;
    this.updateScene3dVisibility();
  }

  setIso3d(on: boolean): void {
    if (on === this.iso3d) return;
    this.toggleIso3d();
  }

  private syncScene3d(refitCamera = false): void {
    if (!this.scene3dWanted() || !this.scene3d || !this.map) return;

    if (this.usesStackedPlate3d()) {
      const floors = this.sortedFloors();
      const layers = floors.map((floor) => {
        const preview = previewMapForFloor(this.map!, floor, this.editFloors);
        const walk = this.walkForFloorLevel(floor);
        const isActive = floor.id === this.activeFloorId;
        const seg = this.routeSegments.find((s) => s.floorId === floor.id);
        const path = seg ? this.trimPathForFloor(floor.id, seg.path) : [];
        const platePois = filterPoisByFloorY(this.pois, floor.floorY, this.editFloors);
        return {
          floorId: floor.id,
          label: floor.label.trim() || 'Floor',
          floorY: floor.floorY,
          map: preview,
          walk: walk ?? new Uint8Array(0),
          objects: floor.objects ?? (isActive ? this.editObjects : []),
          zones: floor.zones ?? (isActive ? this.editZones : []),
          path: path.map((p) => ({ x: p.x, z: p.z })),
          pois: platePois,
        };
      });
      this.scene3d.sync(
        {
          multiFloor: true,
          map: this.map,
          floors: layers,
          connectors: this.routeConnectors,
          floorLevels: this.editFloors,
          walk: this.editWalk ?? new Uint8Array(0),
          objects: this.editObjects,
          zones: this.editZones,
          path: this.path,
          pois: this.pois,
          originId: this.originId,
          destId: this.destId,
          verticalPlateStack: true,
          showWalls: true,
          showInteriorVolumes: true,
          showObjects: true,
        },
        refitCamera,
      );
      return;
    }

    if (!this.editWalk) return;
    const preview = this.previewMap();
    if (!preview) return;
    this.scene3d.sync(
      {
        map: preview,
        walk: this.editWalk,
        objects: this.editObjects,
        zones: this.editZones,
        stores: preview.stores,
        path: this.path,
        pois: this.pois,
        originId: this.originId,
        destId: this.destId,
      },
      refitCamera,
    );
  }

  private buildZoneSidebar(mapParent: HTMLElement): void {
    const layout = mapParent.parentElement;
    if (!layout) return;
    layout.classList.add('floor2d-layout');

    const sidebar = document.createElement('aside');
    sidebar.className = 'floor2d-zone-sidebar';

    const floorHeader = document.createElement('div');
    floorHeader.className = 'floor2d-zone-sidebar__header';
    floorHeader.textContent = 'Floors';

    const floorHint = document.createElement('div');
    floorHint.className = 'floor2d-zone-sidebar__hint';
    floorHint.textContent = 'Click a floor for its plan — View all floors for the 3D stack';

    const floorList = document.createElement('div');
    floorList.className = 'floor2d-zone-list floor2d-floor-list';

    const zoneHeader = document.createElement('div');
    zoneHeader.className = 'floor2d-zone-sidebar__header floor2d-zone-sidebar__header--zones';
    zoneHeader.textContent = 'Zones';

    const zoneHint = document.createElement('div');
    zoneHint.className = 'floor2d-zone-sidebar__hint';
    zoneHint.textContent = 'Click a zone to zoom — use Edit Zone to change or delete';

    const zoneList = document.createElement('div');
    zoneList.className = 'floor2d-zone-list';

    sidebar.append(floorHeader, floorHint, floorList, zoneHeader, zoneHint, zoneList);
    layout.insertBefore(sidebar, mapParent);

    this.zoneSidebar = sidebar;
    this.floorListEl = floorList;
    this.zoneListEl = zoneList;
  }

  private buildZoneNameDialog(parent: HTMLElement): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'floor2d-zone-dialog';
    backdrop.style.display = 'none';

    const panel = document.createElement('div');
    panel.className = 'floor2d-zone-dialog__panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'floor2d-zone-dialog-title');

    const title = document.createElement('div');
    title.id = 'floor2d-zone-dialog-title';
    title.className = 'floor2d-zone-dialog__title';
    title.textContent = 'Zone name';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'floor2d-zone-dialog__input';
    input.placeholder = 'e.g. Food Court, Restrooms';
    input.maxLength = 64;
    input.autocomplete = 'off';
    input.spellcheck = false;

    const actions = document.createElement('div');
    actions.className = 'floor2d-zone-dialog__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'floor2d-zone-dialog__btn floor2d-zone-dialog__btn--cancel';
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'floor2d-zone-dialog__btn floor2d-zone-dialog__btn--ok';
    okBtn.textContent = 'Add Zone';

    const closeDialog = (name: string | null) => {
      backdrop.style.display = 'none';
      const resolve = this.zoneDialogResolve;
      this.zoneDialogResolve = null;
      resolve?.(name);
    };

    const submit = () => {
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      closeDialog(value);
    };

    cancelBtn.addEventListener('click', () => closeDialog(null));
    okBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeDialog(null);
      }
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeDialog(null);
    });

    actions.append(cancelBtn, okBtn);
    panel.append(title, input, actions);
    backdrop.append(panel);
    parent.appendChild(backdrop);

    this.zoneDialog = backdrop;
    this.zoneNameInput = input;
    this.zoneDialogOkBtn = okBtn;
    this.zoneDialogTitle = title;
  }

  private zoneDialogOkBtn: HTMLButtonElement | null = null;
  private zoneDialogTitle: HTMLDivElement | null = null;

  private askRegionName(
    kind: 'zone' | 'floor',
    defaultName = '',
    mode: 'create' | 'rename' = 'create',
  ): Promise<string | null> {
    if (!this.zoneDialog || !this.zoneNameInput || !this.zoneDialogOkBtn || !this.zoneDialogTitle) {
      return Promise.resolve(defaultName.trim() || null);
    }
    const noun = kind === 'floor' ? 'floor' : 'zone';
    this.zoneDialogTitle.textContent = mode === 'rename' ? `Rename ${noun}` : `${noun[0].toUpperCase()}${noun.slice(1)} name`;
    this.zoneDialogOkBtn.textContent = mode === 'rename' ? 'Save' : kind === 'floor' ? 'Add Floor' : 'Add Zone';
    this.zoneNameInput.value = defaultName;
    this.zoneDialog.style.display = 'flex';
    this.zoneNameInput.focus();
    this.zoneNameInput.select();
    return new Promise((resolve) => {
      this.zoneDialogResolve = resolve;
    });
  }

  private askZoneName(defaultName = '', mode: 'create' | 'rename' = 'create'): Promise<string | null> {
    return this.askRegionName('zone', defaultName, mode);
  }

  private askFloorName(defaultName = '', mode: 'create' | 'rename' = 'create'): Promise<string | null> {
    return this.askRegionName('floor', defaultName, mode);
  }

  private async commitNewZone(rect: FloorBlock, shape: 'rectangle' | 'polygon' = 'rectangle', points?: ZonePoint[]): Promise<void> {
    const zoneName = await this.askZoneName('', 'create');
    if (!zoneName) {
      this.draw();
      return;
    }
    this.pushHistory();
    const zone: FloorBlock = {
      ...rect,
      id: `zone-${++this.zoneIdSeq}`,
      fill: 'transparent',
      label: zoneName,
      shape,
      stroke: nextZoneStrokeColor(this.editZones.length),
    };
    if (shape === 'polygon' && points?.length) {
      zone.points = points.map((p) => ({ x: p.x, z: p.z }));
      syncZoneBounds(zone);
    }
    this.editZones.push(zone);
    this.selectZone(zone.id);
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.draw();
  }

  private async finishPolygonDraft(): Promise<void> {
    const pts = this.polygonDraft?.points;
    this.polygonDraft = null;
    if (!pts || pts.length < 3) {
      this.draw();
      return;
    }
    const bounds = boundsFromPoints(pts);
    await this.commitNewZone(
      { id: '', x: bounds.x, z: bounds.z, w: bounds.w, d: bounds.d, fill: 'transparent', label: '' },
      'polygon',
      pts,
    );
  }

  /** Save the current canvas edits onto the active floor level. */
  flushCurrentFloorState(): void {
    if (!this.activeFloorId || !this.map || !this.editWalk) return;
    const floor = this.editFloors.find((f) => f.id === this.activeFloorId);
    if (!floor) return;
    if (!floorLevelSliceMatches(this.map, floor)) return;
    floor.walkGrid = Array.from(this.editWalk);
    floor.objects = cloneBlocks(this.editObjects);
    floor.zones = cloneBlocks(this.editZones);
    floor.gridCols = this.map.cols;
    floor.gridRows = this.map.rows;
    floor.gridCellSize = this.map.cellSize;
    floor.gridMinX = this.map.minX;
    floor.gridMinZ = this.map.minZ;
  }

  private captureCurrentEditsToFloor(floor: FloorLevel): void {
    if (!this.map || !this.editWalk) return;
    floor.walkGrid = Array.from(this.editWalk);
    floor.objects = cloneBlocks(this.editObjects);
    floor.zones = cloneBlocks(this.editZones);
    floor.gridCols = this.map.cols;
    floor.gridRows = this.map.rows;
    floor.gridCellSize = this.map.cellSize;
    floor.gridMinX = this.map.minX;
    floor.gridMinZ = this.map.minZ;
  }

  /** Register current slice Y as a new named level (Floor 1, Floor 2, …). */
  addFloorLevel(floorY: number): FloorLevel {
    this.flushCurrentFloorState();
    const floor: FloorLevel = {
      id: `floor-${++this.floorIdSeq}`,
      label: defaultFloorLabel(this.editFloors.length + 1),
      floorY,
    };
    if (this.map && Math.abs((this.map.sliceY ?? floorY) - floorY) < 1e-4) {
      this.captureCurrentEditsToFloor(floor);
    }
    this.editFloors.push(floor);
    this.activeFloorId = floor.id;
    this.refreshFloorSidebar();
    this.notifyFloorsChange();
    return floor;
  }

  getActiveFloor(): FloorLevel | null {
    return this.editFloors.find((f) => f.id === this.activeFloorId) ?? null;
  }

  getActiveFloorId(): string | null {
    return this.activeFloorId;
  }

  getFloorLevels(): FloorLevel[] {
    return cloneFloorLevels(this.editFloors);
  }

  clearFloorLevels(): void {
    this.editFloors = [];
    this.activeFloorId = null;
    this.floorIdSeq = 0;
    this.refreshFloorSidebar();
    this.notifyFloorsChange();
  }

  clearActiveFloor(): void {
    this.activeFloorId = null;
    this.refreshFloorSidebar();
  }

  async renameActiveFloor(): Promise<boolean> {
    const floor = this.getActiveFloor();
    if (!floor) return false;
    const name = await this.askFloorName(floor.label, 'rename');
    if (!name || name === floor.label) return false;
    floor.label = name;
    this.refreshFloorSidebar();
    this.notifyFloorsChange();
    return true;
  }

  activateFloorLevel(floorId: string): FloorLevel | null {
    const floor = this.editFloors.find((f) => f.id === floorId);
    if (!floor) return null;
    this.flushCurrentFloorState();
    this.activeFloorId = floor.id;
    if (this.viewStack) {
      this.viewStack = false;
      this.disableMultiFloor3dView();
      this.onViewStackChange?.(false);
    }
    this.refreshFloorSidebar();
    this.fit();
    this.onFloorActivate?.(floor);
    this.draw();
    return floor;
  }

  activateViewAllFloors(): void {
    if (!this.usesStackedLayout()) return;
    if (!this.viewStack) this.toggleViewStack();
    else {
      this.syncScene3d(false);
      this.refreshFloorSidebar();
    }
  }

  /** POIs for map + origin/destination lists from the current floor selection. */
  poisForDisplay(source?: NavMapPoi[]): NavMapPoi[] {
    const list = source ?? this.pois;
    if (this.viewStack) return list;
    const active = this.getActiveFloor();
    if (!active || list.length === 0) return list;
    return filterPoisByFloorY(list, active.floorY, this.editFloors);
  }

  setZoneDrawMode(mode: ZoneDrawMode): void {
    this.zoneDrawMode = mode;
    this.polygonDraft = null;
    this.draw();
  }

  getZoneDrawMode(): ZoneDrawMode {
    return this.zoneDrawMode;
  }

  selectZone(id: string | null): void {
    this.selectedZoneId = id;
    this.onZoneSelectionChange?.(id);
    this.refreshZoneSidebar();
    this.draw();
  }

  focusZone(zone: FloorBlock): void {
    this.focusRegion(zone);
  }

  private focusRegion(block: FloorBlock): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const vw = Math.max(1, parent.clientWidth);
    const vh = Math.max(1, parent.clientHeight);
    const pad = 48;
    const zoomW = Math.max(block.w, 0.5);
    const zoomH = Math.max(block.d, 0.5);
    const c = regionCentroid(block);
    this.canvas.width = Math.floor(vw * dpr);
    this.canvas.height = Math.floor(vh * dpr);
    this.scale = Math.min((vw - pad) / zoomW, (vh - pad) / zoomH) * dpr;
    this.offsetX = this.canvas.width / 2 - c.x * this.scale;
    this.offsetY = this.canvas.height / 2 - c.z * this.scale;
    this.draw();
  }

  private refreshFloorSidebar(): void {
    if (!this.floorListEl) return;
    this.floorListEl.replaceChildren();
    if (this.editFloors.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'floor2d-zone-list__empty';
      empty.textContent = 'No floors yet — use Add Floor';
      this.floorListEl.appendChild(empty);
      return;
    }
    if (this.editFloors.length >= 2) {
      const viewAllBtn = document.createElement('button');
      viewAllBtn.type = 'button';
      viewAllBtn.className = 'floor2d-zone-item floor2d-zone-item--view-all';
      if (this.viewStack) viewAllBtn.classList.add('floor2d-zone-item--floor-active');
      const dot = document.createElement('span');
      dot.className = 'floor2d-zone-item__dot';
      dot.style.background = '#5b8def';
      const name = document.createElement('span');
      name.className = 'floor2d-zone-item__name';
      name.textContent = 'View all floors';
      viewAllBtn.append(dot, name);
      viewAllBtn.addEventListener('click', () => {
        this.activateViewAllFloors();
      });
      this.floorListEl.appendChild(viewAllBtn);
    }

    for (let i = 0; i < this.editFloors.length; i++) {
      const floor = this.editFloors[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'floor2d-zone-item';
      if (floor.id === this.activeFloorId && !this.viewStack) {
        btn.classList.add('floor2d-zone-item--floor-active');
      }

      const dot = document.createElement('span');
      dot.className = 'floor2d-zone-item__dot';
      dot.style.background = FLOOR2D_STYLE.floorRegionBorder;

      const name = document.createElement('span');
      name.className = 'floor2d-zone-item__name';
      name.textContent = floor.label.trim() || `Floor ${i + 1}`;

      btn.append(dot, name);
      btn.addEventListener('click', () => {
        this.activateFloorLevel(floor.id);
      });
      btn.addEventListener('dblclick', (e) => {
        e.preventDefault();
        this.activeFloorId = floor.id;
        void this.renameActiveFloor();
      });
      this.floorListEl.appendChild(btn);
    }
  }

  private refreshZoneSidebar(): void {
    if (!this.zoneListEl) return;
    this.zoneListEl.replaceChildren();
    if (this.editZones.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'floor2d-zone-list__empty';
      empty.textContent = 'No zones yet — use Add Zone';
      this.zoneListEl.appendChild(empty);
      return;
    }
    for (const zone of this.editZones) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'floor2d-zone-item';
      if (zone.id === this.selectedZoneId && this.isZoneEditTool()) {
        btn.classList.add('floor2d-zone-item--active');
      }

      const dot = document.createElement('span');
      dot.className = 'floor2d-zone-item__dot';
      dot.style.background = zone.stroke || FLOOR2D_STYLE.accent;

      const name = document.createElement('span');
      name.className = 'floor2d-zone-item__name';
      name.textContent = zone.label.trim() || 'Untitled zone';

      btn.append(dot, name);
      btn.addEventListener('click', () => {
        if (this.isZoneEditTool()) this.selectZone(zone.id);
        this.focusZone(zone);
      });
      this.zoneListEl.appendChild(btn);
    }
  }

  setOnToolChange(fn: (tool: Floor2DTool) => void): void {
    this.onToolChange = fn;
  }

  setOnDirtyChange(fn: (dirty: boolean) => void): void {
    this.onDirtyChange = fn;
  }

  setOnHistoryChange(fn: (canUndo: boolean, canRedo: boolean) => void): void {
    this.onHistoryChange = fn;
  }

  setOnZonesChange(fn: () => void): void {
    this.onZonesChange = fn;
  }

  setOnFloorsChange(fn: () => void): void {
    this.onFloorsChange = fn;
  }

  setOnRouteRebuild(fn: () => void): void {
    this.onRouteRebuild = fn;
  }

  setOnZoneSelectionChange(fn: (zoneId: string | null) => void): void {
    this.onZoneSelectionChange = fn;
    fn(this.selectedZoneId);
  }

  setOnFloorActivate(fn: (floor: FloorLevel) => void): void {
    this.onFloorActivate = fn;
  }

  setOnViewStackChange(fn: (on: boolean) => void): void {
    this.onViewStackChange = fn;
  }

  deleteSelectedZone(): boolean {
    if (!this.selectedZoneId) return false;
    this.pushHistory();
    this.editZones = this.editZones.filter((z) => z.id !== this.selectedZoneId);
    this.selectZone(null);
    this.notifyZonesChange();
    this.draw();
    return true;
  }

  deleteActiveFloor(): boolean {
    if (!this.activeFloorId) return false;
    const removed = this.activeFloorId;
    this.editFloors = this.editFloors.filter((f) => f.id !== removed);
    this.activeFloorId = this.editFloors[0]?.id ?? null;
    this.refreshFloorSidebar();
    this.notifyFloorsChange();
    const next = this.getActiveFloor();
    if (next) this.onFloorActivate?.(next);
    return true;
  }

  /** Zones available as origin/destination (navigate to center point). */
  getRouteZones(): { id: string; label: string }[] {
    return this.editZones.map((z) => ({
      id: z.id,
      label: z.label.trim() || 'Untitled zone',
    }));
  }

  /** Named floor regions for origin/destination routing. */
  getRouteFloors(): { id: string; label: string; floorY?: number }[] {
    return this.editFloors.map((f) => ({
      id: f.id,
      label: f.label.trim() || 'Untitled floor',
      floorY: f.floorY,
    }));
  }

  /**
   * Route on painted walkable floor (A* grid) — avoids objects/blocks, not Recast nav mesh.
   */
  computeRoutePath(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
    floorY: number,
  ): { path: { x: number; y: number; z: number }[]; error?: string } {
    if (!this.map || !this.editWalk) {
      return { path: [], error: 'Floor map not ready' };
    }
    const out = findPathOnFloorGrid(
      this.map,
      this.editWalk,
      this.editObjects,
      startX,
      startZ,
      endX,
      endZ,
      floorY,
    );
    if ('error' in out) return { path: [], error: out.error };
    return { path: out.path };
  }

  usesStackedLayout(): boolean {
    return this.editFloors.length >= 2;
  }

  hasValidRoute(): boolean {
    if (this.routeSegments.length > 0) {
      return this.routeSegments.some((s) => s.path.length >= 2);
    }
    return this.path.length >= 2;
  }

  setRoutePlan(
    segments: FloorRouteSegment[],
    connectors: FloorRouteConnector[],
    error?: string,
    debug?: {
      forward?: FloorRouteSegment[];
      reverse?: FloorRouteSegment[];
      breakPoints?: RouteBreakPoint[];
    },
  ): void {
    const refit3d = this.routeSegments.length === 0 && segments.length > 0;
    const hasRoute = segments.some((s) => s.path.length >= 2);
    this.routeSegments = segments;
    this.routeConnectors = connectors;
    this.routeBreakPoints = debug?.breakPoints ?? [];
    this.routeDebugForward = debug?.forward ?? [];
    this.routeDebugReverse = debug?.reverse ?? [];
    this.routeError = hasRoute ? (error ?? null) : (error ?? null);
    if (segments.length === 1) {
      this.path = segments[0].path.map((p) => ({ x: p.x, z: p.z }));
    } else {
      this.path = [];
    }
    if (this.usesStackedPlate3d()) {
      this.enableMultiFloor3dView();
      this.syncScene3d(refit3d);
      return;
    }
    this.draw();
  }

  computeAndSetRoute(
    navMesh: NavMesh | null,
    origin: { x: number; y: number; z: number },
    destination: { x: number; y: number; z: number },
  ): { valid: boolean; error?: string } {
    if (!this.map) {
      this.setRoutePlan([], [], 'Floor map not ready');
      return { valid: false, error: 'Floor map not ready' };
    }
    const plan = computeMultiFloorRoute(
      this.map,
      this.editFloors,
      navMesh,
      origin,
      destination,
      this.editWalk,
      this.activeFloorId,
      this.editObjects,
    );
    this.setRoutePlan(plan.segments, plan.connectors, plan.error, {
      forward: plan.debugForward,
      reverse: plan.debugReverse,
      breakPoints: plan.breakPoints,
    });
    return {
      valid: plan.segments.some((s) => s.path.length >= 2),
      error: plan.error,
    };
  }

  resolveRouteEndpoint(
    id: string,
    sliceY: number,
  ): { x: number; y: number; z: number; name: string } | null {
    const floorId = parseFloorRouteId(id);
    if (floorId) {
      const floor = this.editFloors.find((f) => f.id === floorId);
      if (!floor || !this.map) return null;
      const x = (this.map.minX + this.map.maxX) * 0.5;
      const z = (this.map.minZ + this.map.maxZ) * 0.5;
      return { x, y: floor.floorY, z, name: floor.label.trim() || 'Untitled floor' };
    }
    const zoneId = parseZoneRouteId(id);
    if (zoneId) {
      const zone = this.editZones.find((z) => z.id === zoneId);
      if (!zone) return null;
      const c = zoneCentroid(zone);
      return { x: c.x, y: sliceY, z: c.z, name: zone.label.trim() || 'Untitled zone' };
    }
    const poi = this.pois.find((p) => p.id === id) ?? findNavMapPoi(id);
    if (poi) return { x: poi.x, y: poi.y, z: poi.z, name: poi.name };
    return null;
  }

  private notifyZonesChange(): void {
    this.onZonesChange?.();
  }

  private notifyFloorsChange(): void {
    this.onFloorsChange?.();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const snap = this.undoStack.pop();
    if (!snap || !this.editWalk) return false;
    this.redoStack.push(this.cloneSnapshot()!);
    this.editWalk = snap.walk;
    this.editObjects = cloneBlocks(snap.objects);
    this.editZones = cloneBlocks(snap.zones);
    if (this.selectedZoneId && !this.editZones.some((z) => z.id === this.selectedZoneId)) {
      this.selectedZoneId = null;
    }
    this.flushCurrentFloorState();
    this.refreshFloorSidebar();
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.syncEditState();
    this.draw();
    return true;
  }

  redo(): boolean {
    const snap = this.redoStack.pop();
    if (!snap || !this.editWalk) return false;
    this.undoStack.push(this.cloneSnapshot()!);
    this.editWalk = snap.walk;
    this.editObjects = cloneBlocks(snap.objects);
    this.editZones = cloneBlocks(snap.zones);
    if (this.selectedZoneId && !this.editZones.some((z) => z.id === this.selectedZoneId)) {
      this.selectedZoneId = null;
    }
    this.flushCurrentFloorState();
    this.refreshFloorSidebar();
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.syncEditState();
    this.draw();
    return true;
  }

  setTool(tool: Floor2DTool): void {
    this.tool = tool;
    if (tool !== 'zone') this.polygonDraft = null;
    if (tool !== 'zone-edit') this.zoneEdit = null;
    if (tool === 'zone') this.selectedZoneId = null;
    else if (tool !== 'zone-edit') this.selectedZoneId = null;
    if (tool === 'pan') this.canvas.style.cursor = 'grab';
    else if (tool === 'zone-edit') this.canvas.style.cursor = 'default';
    else this.canvas.style.cursor = 'crosshair';
    this.onToolChange?.(tool);
    this.refreshZoneSidebar();
    if (this.usesStackedLayout()) {
      this.fit();
      if (tool === 'pan' && this.viewStack) this.enableMultiFloor3dView();
      else if (this.multiFloor3dAuto) this.disableMultiFloor3dView();
    }
    this.draw();
  }

  private isZoneEditTool(): boolean {
    return this.tool === 'zone-edit';
  }

  getTool(): Floor2DTool {
    return this.tool;
  }

  setObjectShape(shape: FloorShape): void {
    this.objectShape = shape;
    this.draw();
  }

  getObjectShape(): FloorShape {
    return this.objectShape;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  saveEdits(): boolean {
    if (!this.map || !this.editWalk) return false;
    this.flushCurrentFloorState();
    this.map = applyWalkGridEdits(this.map, this.editWalk, this.editObjects, this.editZones, this.editFloors);
    this.clearHistory();
    this.draw();
    return true;
  }

  hasMap(): boolean {
    return this.map !== null && this.editWalk !== null;
  }

  /** Snapshot for DB persistence (includes walk grid + named zones). */
  exportEditPayload(sliceY: number, mapCode: string): NavmeFloorEditPayload | null {
    if (!this.map || !this.editWalk) return null;
    this.flushCurrentFloorState();
    const active = this.getActiveFloor();
    return buildFloorEditPayload(
      this.map,
      this.editWalk,
      this.editObjects,
      this.editZones,
      this.editFloors,
      active?.floorY ?? sliceY,
      mapCode,
    );
  }

  getEditStateForSave(): {
    map: Floor2DMap;
    walk: Uint8Array;
    objects: FloorBlock[];
    zones: FloorBlock[];
    floors: FloorLevel[];
  } | null {
    if (!this.map || !this.editWalk) return null;
    this.flushCurrentFloorState();
    return {
      map: { ...this.map, floors: cloneFloorLevels(this.editFloors) },
      walk: this.editWalk,
      objects: cloneBlocks(this.editObjects),
      zones: cloneBlocks(this.editZones),
      floors: cloneFloorLevels(this.editFloors),
    };
  }

  setMap(map: Floor2DMap, options: { preserveFloors?: boolean; activeFloorId?: string | null } = {}): void {
    const preserveFloors = options.preserveFloors === true;
    const incomingFloors = map.floors ?? [];

    if (!preserveFloors) {
      if (incomingFloors.length > 0) {
        this.editFloors = cloneFloorLevels(incomingFloors);
        this.floorIdSeq = this.editFloors.reduce((max, f) => {
          const m = /^floor-(\d+)$/.exec(f.id);
          return m ? Math.max(max, parseInt(m[1], 10)) : max;
        }, 0);
        const match =
          this.editFloors.find((f) => Math.abs(f.floorY - map.sliceY) < 1e-4) ??
          this.editFloors[0] ??
          null;
        this.activeFloorId = options.activeFloorId ?? match?.id ?? null;
      } else if (this.editFloors.length === 0) {
        this.activeFloorId = options.activeFloorId ?? null;
      } else if (options.activeFloorId !== undefined) {
        this.activeFloorId = options.activeFloorId;
      }
    } else if (options.activeFloorId !== undefined) {
      this.activeFloorId = options.activeFloorId;
    }

    this.map = { ...map, floors: cloneFloorLevels(this.editFloors) };
    const active = this.getActiveFloor();
    if (active && floorLevelGridMatches(map, active)) {
      this.editWalk = new Uint8Array(active.walkGrid!.map((v) => (v ? 1 : 0)));
      this.editObjects = cloneBlocks(active.objects ?? []);
      this.editZones = cloneBlocks(active.zones ?? []);
    } else if (active && floorLevelSliceMatches(map, active) && active.walkGrid?.length) {
      this.editWalk = new Uint8Array(active.walkGrid.map((v) => (v ? 1 : 0)));
      this.editObjects = cloneBlocks(active.objects ?? []);
      this.editZones = cloneBlocks(active.zones ?? []);
    } else {
      const blocks = map.corridors.length > 0 ? map.corridors : map.blocks;
      this.editWalk = walkGridFromBlocks(map, blocks);
      this.editObjects = cloneBlocks(map.objects ?? []);
      this.editZones = cloneBlocks(map.zones ?? []);
    }

    this.objectIdSeq = this.editObjects.reduce((max, o) => {
      const m = /^obj-(\d+)$/.exec(o.id);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    this.zoneIdSeq = this.editZones.reduce((max, z) => {
      const m = /^zone-(\d+)$/.exec(z.id);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    this.selectedZoneId = null;
    this.polygonDraft = null;
    this.clearHistory();
    this.fit();
    this.refreshFloorSidebar();
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.notifyFloorsChange();
    this.draw();
  }

  setPath(points: { x: number; y: number; z: number }[]): void {
    this.routeSegments = [];
    this.routeConnectors = [];
    this.routeError = null;
    this.routeDebugForward = [];
    this.routeDebugReverse = [];
    this.routeBreakPoints = [];
    this.path = points.map((p) => ({ x: p.x, z: p.z }));
    this.draw();
  }

  setPois(pois: NavMapPoi[], originId: string, destId: string): void {
    this.pois = pois;
    this.originId = originId;
    this.destId = destId;
    this.draw();
  }

  isNavMeshVisible(): boolean {
    return this.showNavMesh;
  }

  setNavMeshVisible(visible: boolean, navMesh: NavMesh | null, sliceY: number): void {
    this.showNavMesh = visible;
    if (!visible || !navMesh) {
      this.navMeshTris = [];
      this.draw();
      return;
    }
    try {
      this.navMeshTris = extractNavMeshSlice2D(navMesh, sliceY);
    } catch {
      this.navMeshTris = [];
    }
    this.draw();
  }

  refreshNavMeshOverlay(navMesh: NavMesh | null, sliceY: number): void {
    if (!this.showNavMesh) return;
    this.setNavMeshVisible(true, navMesh, sliceY);
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.scene3d?.resize(w, h);
    this.draw();
  }

  fit(): void {
    if (!this.map) return;
    if (this.usesStackedPlate3d()) {
      return;
    }
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    const mapW = this.map.maxX - this.map.minX;
    const mapH = this.map.maxZ - this.map.minZ;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.scale = Math.min((w * 0.9) / mapW, (h * 0.9) / mapH) * dpr;
    this.offsetX = (this.canvas.width - mapW * this.scale) / 2 - this.map.minX * this.scale;
    this.offsetY = (this.canvas.height - mapH * this.scale) / 2 - this.map.minZ * this.scale;
  }

  private fitStackedView(): void {
    if (!this.map) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    const mapW = this.map.maxX - this.map.minX;
    const mapH = this.map.maxZ - this.map.minZ;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const layerCount = this.editFloors.length;
    const gapPx = this.stackGapPx(dpr);
    const pad = this.platePadPx(dpr);
    const thickness = this.plateThicknessPx(dpr);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    const scaleW = ((w * 0.86) / mapW) * dpr;
    const plateHAtScaleW = mapH * scaleW + pad * 2 + thickness;
    const totalHAtScaleW = plateHAtScaleW * layerCount + gapPx * Math.max(0, layerCount - 1);
    const scaleH = ((h * 0.86) / totalHAtScaleW) * dpr;
    this.scale = Math.min(scaleW, scaleH);
    const plateH = mapH * this.scale + pad * 2 + thickness;
    const contentH = plateH * layerCount + gapPx * Math.max(0, layerCount - 1);
    this.offsetX = (this.canvas.width - mapW * this.scale) / 2 - this.map.minX * this.scale;
    this.offsetY = (this.canvas.height - contentH) / 2 - this.map.minZ * this.scale;
  }

  private sortedFloors(): FloorLevel[] {
    return [...this.editFloors].sort((a, b) => a.floorY - b.floorY);
  }

  /** Visible air gap between stacked floor plates. */
  private stackGapPx(dpr: number): number {
    return 48 * dpr;
  }

  private plateThicknessPx(dpr: number): number {
    return 7 * dpr;
  }

  private platePadPx(dpr: number): number {
    return 8 * dpr;
  }

  /** Lower floor at bottom; each higher floor stacks upward. */
  private stackLayerDy(layerIndex: number, mapH: number, gapPx: number, dpr: number): number {
    const pad = this.platePadPx(dpr);
    const plateThickness = this.plateThicknessPx(dpr);
    const plateH = mapH * this.scale + pad * 2 + plateThickness;
    return -layerIndex * (plateH + gapPx);
  }

  private layerDyForFloorId(
    floorId: string,
    floors: FloorLevel[],
    mapH: number,
    gapPx: number,
    dpr: number,
  ): number {
    const idx = floors.findIndex((f) => f.id === floorId);
    return idx >= 0 ? this.stackLayerDy(idx, mapH, gapPx, dpr) : 0;
  }

  private plateBounds(
    layerIndex: number,
    mapH: number,
    gapPx: number,
    dpr: number,
  ): { x0: number; y0: number; x1: number; y1: number; dy: number; thickness: number } {
    const pad = this.platePadPx(dpr);
    const thickness = this.plateThicknessPx(dpr);
    const dy = this.stackLayerDy(layerIndex, mapH, gapPx, dpr);
    const x0 = this.wx(this.map!.minX) - pad;
    const y0 = this.wz(this.map!.minZ) - pad;
    const cardW = (this.map!.maxX - this.map!.minX) * this.scale + pad * 2;
    const cardH = mapH * this.scale + pad * 2;
    return { x0, y0, x1: x0 + cardW, y1: y0 + cardH, dy, thickness };
  }

  private cloneSnapshot(): EditSnapshot | null {
    if (!this.editWalk) return null;
    return {
      walk: new Uint8Array(this.editWalk),
      objects: cloneBlocks(this.editObjects),
      zones: cloneBlocks(this.editZones),
    };
  }

  private pushHistory(): void {
    const snap = this.cloneSnapshot();
    if (!snap) return;
    this.undoStack.push(snap);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.syncEditState();
  }

  private clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.syncEditState();
  }

  private syncEditState(): void {
    const dirty = this.undoStack.length > 0;
    if (this.dirty !== dirty) {
      this.dirty = dirty;
      this.onDirtyChange?.(dirty);
    }
    this.onHistoryChange?.(this.canUndo(), this.canRedo());
  }

  private previewMap(): Floor2DMap | null {
    if (!this.map || !this.editWalk) return null;
    return applyWalkGridEdits(this.map, this.editWalk, this.editObjects, this.editZones, this.editFloors);
  }

  private wx(x: number): number {
    return x * this.scale + this.offsetX;
  }

  private wz(z: number): number {
    return z * this.scale + this.offsetY;
  }

  private screenToWorld(clientX: number, clientY: number): { x: number; z: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    let sx = (clientX - rect.left) * dpr;
    let sy = (clientY - rect.top) * dpr;
    if (this.usesStackedLayout() && this.tool !== 'pan' && this.map && this.activeFloorId) {
      const floors = this.sortedFloors();
      const gapPx = this.stackGapPx(dpr);
      const mapH = this.map.maxZ - this.map.minZ;
      sy -= this.layerDyForFloorId(this.activeFloorId, floors, mapH, gapPx, dpr);
    }
    return { x: (sx - this.offsetX) / this.scale, z: (sy - this.offsetY) / this.scale };
  }

  private handleRadiusWorld(): number {
    return HANDLE_RADIUS_PX / Math.max(this.scale, 0.001);
  }

  private applyZoneEdit(x: number, z: number): void {
    if (!this.zoneEdit) return;
    const { block, handle, startWorld, snapshot } = this.zoneEdit;
    applyRegionEdit(block, handle, snapshot, startWorld, x, z);
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (this.tool === 'zone') {
        if (e.key === 'Enter') {
          e.preventDefault();
          void this.finishPolygonDraft();
        } else if (e.key === 'Escape') {
          this.polygonDraft = null;
          this.draw();
        }
        return;
      }

      if (this.isZoneEditTool()) {
        if (e.key === 'Escape') {
          this.zoneEdit = null;
          this.selectZone(null);
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedZoneId) {
          e.preventDefault();
          this.deleteSelectedZone();
        }
        return;
      }
    });
  }

  private beginZoneEditPointer(w: { x: number; z: number }): boolean {
    const handleHit = hitRegionHandle(
      this.editZones,
      this.selectedZoneId,
      w.x,
      w.z,
      this.handleRadiusWorld(),
    );
    if (handleHit) {
      this.selectZone(handleHit.block.id);
      this.zoneEdit = {
        block: handleHit.block,
        handle: handleHit.handle,
        startWorld: w,
        snapshot: cloneRegionBlock(handleHit.block),
        historyPushed: false,
      };
      this.canvas.style.cursor = 'grabbing';
      return true;
    }

    const zoneHit = hitTestRegion(this.editZones, w.x, w.z);
    if (zoneHit) {
      this.selectZone(zoneHit.id);
      this.zoneEdit = {
        block: zoneHit,
        handle: { kind: 'move' },
        startWorld: w,
        snapshot: cloneRegionBlock(zoneHit),
        historyPushed: false,
      };
      this.canvas.style.cursor = 'grab';
      return true;
    }

    this.selectZone(null);
    return false;
  }

  private bindPointer(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);

      if (this.tool === 'pan') {
        this.dragging = true;
        this.canvas.style.cursor = 'grabbing';
        return;
      }

      const w = this.screenToWorld(e.clientX, e.clientY);

      if (this.isZoneEditTool()) {
        this.beginZoneEditPointer(w);
        return;
      }

      if (this.tool === 'zone') {
        // Add Zone: never select or edit existing zones — draw only.
        if (this.zoneDrawMode === 'polygon') {
          const closeDist = CLOSE_POLY_DIST_PX / Math.max(this.scale, 0.001);
          if (this.polygonDraft && this.polygonDraft.points.length >= 3) {
            const first = this.polygonDraft.points[0];
            if (dist2(w.x, w.z, first.x, first.z) <= closeDist * closeDist) {
              void this.finishPolygonDraft();
              return;
            }
          }
          if (!this.polygonDraft) {
            this.polygonDraft = { points: [], cursorX: w.x, cursorZ: w.z };
          }
          this.polygonDraft.points.push({ x: w.x, z: w.z });
          this.polygonDraft.cursorX = w.x;
          this.polygonDraft.cursorZ = w.z;
          this.draw();
          return;
        }

        this.draft = { x0: w.x, z0: w.z, x1: w.x, z1: w.z };
        this.draw();
        return;
      }

      this.draft = { x0: w.x, z0: w.z, x1: w.x, z1: w.z };
      this.draw();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.tool === 'pan' && this.dragging) {
        const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
        this.offsetX += (e.clientX - this.lastX) * dpr;
        this.offsetY += (e.clientY - this.lastY) * dpr;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.draw();
        return;
      }

      if (this.zoneEdit) {
        const moved = Math.hypot(e.clientX - this.lastX, e.clientY - this.lastY);
        if (!this.zoneEdit.historyPushed && moved > 4) {
          this.pushHistory();
          this.zoneEdit.historyPushed = true;
        }
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.applyZoneEdit(w.x, w.z);
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.draw();
        return;
      }

      if (this.polygonDraft) {
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.polygonDraft.cursorX = w.x;
        this.polygonDraft.cursorZ = w.z;
        this.draw();
        return;
      }

      if (this.draft) {
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.draft.x1 = w.x;
        this.draft.z1 = w.z;
        this.draw();
      }
    });

    const end = (e: PointerEvent) => {
      try {
        if (this.canvas.hasPointerCapture(e.pointerId)) {
          this.canvas.releasePointerCapture(e.pointerId);
        }
      } catch {
        /* ignore */
      }

      if (this.zoneEdit) {
        this.zoneEdit = null;
        this.dragging = false;
        this.canvas.style.cursor = this.isZoneEditTool() ? 'default' : 'crosshair';
        this.refreshZoneSidebar();
        this.onRouteRebuild?.();
        this.draw();
        return;
      }

      if (this.draft && this.map && this.editWalk) {
        const r = normRect(this.draft.x0, this.draft.z0, this.draft.x1, this.draft.z1);
        const valid = r.w >= MIN_BLOCK && r.d >= MIN_BLOCK;
        if (valid && this.tool === 'zone' && this.zoneDrawMode === 'rectangle') {
          const rect = { ...r };
          this.draft = null;
          this.dragging = false;
          this.canvas.style.cursor = 'crosshair';
          this.draw();
          void this.commitNewZone(rect, 'rectangle');
          return;
        }
        if (valid) {
          this.pushHistory();
          if (this.tool === 'add') {
            paintRectOnWalk(this.map, this.editWalk, r, 1);
          } else if (this.tool === 'cut') {
            paintRectOnWalk(this.map, this.editWalk, r, 0);
          } else if (this.tool === 'object') {
            this.editObjects.push({
              ...r,
              id: `obj-${++this.objectIdSeq}`,
              fill: FLOOR2D_STYLE.object,
              label: '',
              shape: this.objectShape,
            });
          }
          if (this.tool === 'add' || this.tool === 'cut' || this.tool === 'object') {
            this.onRouteRebuild?.();
          }
        }
        this.draft = null;
      }
      this.dragging = false;
      this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
      this.draw();
    };

    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        this.scale = Math.max(0.2, Math.min(80, this.scale * factor));
        this.draw();
      },
      { passive: false },
    );

    this.canvas.addEventListener('dblclick', (e) => {
      if (!this.map) return;
      const w = this.screenToWorld(e.clientX, e.clientY);
      if (this.isZoneEditTool()) {
        const zoneHit = hitTestRegion(this.editZones, w.x, w.z);
        if (zoneHit) {
          void (async () => {
            const name = await this.askZoneName(zoneHit.label, 'rename');
            if (name && name !== zoneHit.label) {
              this.pushHistory();
              zoneHit.label = name;
              this.refreshZoneSidebar();
              this.notifyZonesChange();
            }
            this.draw();
          })();
        }
        return;
      }
    });
  }

  private drawShape(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    shape: FloorShape | undefined,
    fill: string,
    stroke: string,
    lineW: number,
    dashed: boolean,
  ): void {
    ctx.save();
    ctx.lineWidth = lineW;
    ctx.strokeStyle = stroke;
    if (dashed) ctx.setLineDash([6, 4]);
    if (shape === 'circle') {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
      if (fill && fill !== 'transparent') {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.stroke();
    } else {
      if (fill && fill !== 'transparent') {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, h);
      }
      const inset = lineW * 0.5;
      const sw = Math.max(1, w - lineW);
      const sh = Math.max(1, h - lineW);
      ctx.strokeRect(x + inset, y + inset, sw, sh);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawZoneLabel(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    dpr: number,
    color: string = FLOOR2D_STYLE.zoneLabel,
  ): void {
    if (!label) return;
    const fontSize = Math.max(9, 11 * dpr);
    ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = x + w / 2;
    const cy = y + h / 2;
    const text = truncateLabel(label, 28);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 3 * dpr, y + 3 * dpr, w - 6 * dpr, h - 6 * dpr);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillText(text, cx, cy);
    ctx.restore();
  }

  private drawNavMesh(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (!this.showNavMesh || this.navMeshTris.length === 0) return;
    ctx.fillStyle = FLOOR2D_STYLE.navMesh;
    ctx.strokeStyle = FLOOR2D_STYLE.navMeshStroke;
    ctx.lineWidth = Math.max(0.5, 0.75 * dpr);
    for (const tri of this.navMeshTris) {
      ctx.beginPath();
      ctx.moveTo(this.wx(tri.ax), this.wz(tri.az));
      ctx.lineTo(this.wx(tri.bx), this.wz(tri.bz));
      ctx.lineTo(this.wx(tri.cx), this.wz(tri.cz));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  private drawWalkGrid(ctx: CanvasRenderingContext2D, walkOverride?: Uint8Array | null): void {
    const walk = walkOverride ?? this.editWalk;
    if (!this.map || !walk) return;
    const { minX, minZ, cellSize, cols, rows } = this.map;
    const cellPx = cellSize * this.scale;
    ctx.fillStyle = FLOOR2D_STYLE.corridor;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!walk[r * cols + c]) continue;
        const x = minX + c * cellSize;
        const z = minZ + r * cellSize;
        ctx.fillRect(this.wx(x), this.wz(z), cellPx, cellPx);
      }
    }
  }

  private drawObjects(ctx: CanvasRenderingContext2D, dpr: number, objects?: FloorBlock[]): void {
    const lineW = Math.max(1.25, 1.5 * dpr);
    for (const b of objects ?? this.editObjects) {
      const x = this.wx(b.x);
      const y = this.wz(b.z);
      const w = b.w * this.scale;
      const h = b.d * this.scale;
      this.drawShape(
        ctx,
        x,
        y,
        w,
        h,
        b.shape ?? 'rectangle',
        b.fill || FLOOR2D_STYLE.object,
        FLOOR2D_STYLE.objectBorder,
        lineW,
        false,
      );
    }
  }

  private drawZoneOutline(
    ctx: CanvasRenderingContext2D,
    zone: FloorBlock,
    stroke: string,
    lineW: number,
    dashed: boolean,
    selected: boolean,
  ): void {
    ctx.save();
    ctx.lineWidth = selected ? lineW + 1 : lineW;
    ctx.strokeStyle = stroke;
    if (dashed) ctx.setLineDash([6, 4]);
    if (isPolygonZone(zone) && zone.points) {
      ctx.beginPath();
      for (let i = 0; i < zone.points.length; i++) {
        const p = zone.points[i];
        const sx = this.wx(p.x);
        const sy = this.wz(p.z);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      ctx.stroke();
    } else {
      const x = this.wx(zone.x);
      const y = this.wz(zone.z);
      const w = zone.w * this.scale;
      const h = zone.d * this.scale;
      this.drawShape(ctx, x, y, w, h, zone.shape ?? 'rectangle', 'transparent', stroke, lineW, dashed);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawZoneHandles(ctx: CanvasRenderingContext2D, zone: FloorBlock, dpr: number): void {
    const r = Math.max(4, HANDLE_RADIUS_PX * 0.55 * dpr);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = zone.stroke || FLOOR2D_STYLE.accent;
    ctx.lineWidth = Math.max(1.5, 2 * dpr);

    const drawHandle = (wx: number, wz: number) => {
      const sx = this.wx(wx);
      const sy = this.wz(wz);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };

    if (isPolygonZone(zone) && zone.points) {
      for (const p of zone.points) drawHandle(p.x, p.z);
      return;
    }

    drawHandle(zone.x, zone.z);
    drawHandle(zone.x + zone.w, zone.z);
    drawHandle(zone.x, zone.z + zone.d);
    drawHandle(zone.x + zone.w, zone.z + zone.d);
  }

  private drawRegionPolygonDraft(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    draft: { points: ZonePoint[]; cursorX: number; cursorZ: number } | null,
    stroke: string,
  ): void {
    if (!draft || draft.points.length === 0) return;
    const pts = draft.points;
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(2, 2.5 * dpr);
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(this.wx(pts[0].x), this.wz(pts[0].z));
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(this.wx(pts[i].x), this.wz(pts[i].z));
    }
    ctx.lineTo(this.wx(draft.cursorX), this.wz(draft.cursorZ));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = stroke;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(this.wx(p.x), this.wz(p.z), Math.max(3, 4 * dpr), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawPolygonDraft(ctx: CanvasRenderingContext2D, dpr: number): void {
    this.drawRegionPolygonDraft(ctx, dpr, this.polygonDraft, FLOOR2D_STYLE.accent);
  }

  private drawZones(ctx: CanvasRenderingContext2D, dpr: number, zones?: FloorBlock[]): void {
    const lineW = Math.max(2, 2.5 * dpr);
    for (const b of zones ?? this.editZones) {
      const stroke = b.stroke || FLOOR2D_STYLE.accent;
      const selected = b.id === this.selectedZoneId;
      this.drawZoneOutline(ctx, b, stroke, lineW, true, selected);
      const x = this.wx(b.x);
      const y = this.wz(b.z);
      const w = b.w * this.scale;
      const h = b.d * this.scale;
      this.drawZoneLabel(ctx, x, y, w, h, b.label, dpr, stroke);
      if (selected && this.isZoneEditTool()) this.drawZoneHandles(ctx, b, dpr);
    }
  }

  private drawStores(ctx: CanvasRenderingContext2D, m: Floor2DMap, dpr: number): void {
    const lineW = Math.max(0.75, 0.85 * dpr);
    ctx.lineWidth = lineW;
    ctx.strokeStyle = FLOOR2D_STYLE.wallLight;
    ctx.fillStyle = FLOOR2D_STYLE.store;
    for (const b of m.stores) {
      const x = this.wx(b.x);
      const y = this.wz(b.z);
      const w = b.w * this.scale;
      const h = b.d * this.scale;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + lineW * 0.5, y + lineW * 0.5, w - lineW, h - lineW);
      this.drawZoneLabel(ctx, x, y, w, h, zoneDisplayLabel(b, this.pois), dpr, FLOOR2D_STYLE.zoneLabel);
    }
  }

  private drawWalls(ctx: CanvasRenderingContext2D, m: Floor2DMap, dpr: number): void {
    ctx.strokeStyle = FLOOR2D_STYLE.wall;
    ctx.lineWidth = Math.max(0.85, 1 * dpr);
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    for (const seg of m.walls) {
      ctx.beginPath();
      ctx.moveTo(this.wx(seg.x1), this.wz(seg.z1));
      ctx.lineTo(this.wx(seg.x2), this.wz(seg.z2));
      ctx.stroke();
    }
  }

  private drawDraft(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (!this.draft) return;
    const r = normRect(this.draft.x0, this.draft.z0, this.draft.x1, this.draft.z1);
    const x = this.wx(r.x);
    const y = this.wz(r.z);
    const w = r.w * this.scale;
    const h = r.d * this.scale;
    if (this.tool === 'cut') {
      ctx.fillStyle = 'rgba(245,245,245,0.8)';
      ctx.strokeStyle = '#e57373';
    } else if (this.tool === 'object') {
      this.drawShape(
        ctx,
        x,
        y,
        w,
        h,
        this.objectShape,
        'rgba(255,255,255,0.85)',
        FLOOR2D_STYLE.objectBorder,
        1.5 * dpr,
        false,
      );
      return;
    } else if (this.tool === 'zone' && this.zoneDrawMode === 'rectangle') {
      this.drawShape(
        ctx,
        x,
        y,
        w,
        h,
        'rectangle',
        'transparent',
        FLOOR2D_STYLE.accent,
        2 * dpr,
        true,
      );
      return;
    } else {
      ctx.fillStyle = 'rgba(224,224,224,0.55)';
      ctx.strokeStyle = FLOOR2D_STYLE.wallLight;
    }
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  private drawRouteOnPath(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    path: FloorPathPoint[] | { x: number; z: number }[],
    color = FLOOR2D_STYLE.route,
    dashed = false,
    lineWidth?: number,
  ): void {
    if (path.length < 2) return;
    const lw = lineWidth ?? Math.max(7, 8 * dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(this.wx(path[0].x), this.wz(path[0].z));
    for (let i = 1; i < path.length; i++) {
      ctx.lineTo(this.wx(path[i].x), this.wz(path[i].z));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    if (dashed) ctx.setLineDash([6 * dpr, 5 * dpr]);
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
  }

  private drawRouteDebugForFloor(ctx: CanvasRenderingContext2D, dpr: number, floorId: string): void {
    const fwd = this.routeDebugForward.find((s) => s.floorId === floorId);
    const rev = this.routeDebugReverse.find((s) => s.floorId === floorId);
    if (fwd) {
      this.drawRouteOnPath(ctx, dpr, fwd.path, '#16a34a', true, Math.max(4, 5 * dpr));
    }
    if (rev) {
      this.drawRouteOnPath(ctx, dpr, rev.path, '#ea580c', true, Math.max(4, 5 * dpr));
    }
  }

  private drawRouteDebugLegend(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (this.routeDebugForward.length === 0 && this.routeDebugReverse.length === 0) return;
    const fontSize = Math.max(9, 10 * dpr);
    const pad = 10 * dpr;
    const lineH = fontSize + 6 * dpr;
    const rows = [
      { color: FLOOR2D_STYLE.route, label: 'Merged route', dashed: false },
      { color: '#16a34a', label: 'O→D probe', dashed: true },
      { color: '#ea580c', label: 'D→O probe', dashed: true },
      { color: '#dc2626', label: 'Break / bridge', dashed: false },
    ];
    const boxW = 132 * dpr;
    const boxH = pad * 2 + rows.length * lineH;
    const x0 = pad;
    const y0 = pad;

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = 'rgba(15,23,42,0.12)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.roundRect(x0, y0, boxW, boxH, 8 * dpr);
    ctx.fill();
    ctx.stroke();

    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    rows.forEach((row, i) => {
      const y = y0 + pad + i * lineH + lineH * 0.5;
      const lx = x0 + pad;
      ctx.strokeStyle = row.color;
      ctx.lineWidth = row.dashed ? 2 * dpr : 4 * dpr;
      if (row.dashed) ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(lx, y);
      ctx.lineTo(lx + 22 * dpr, y);
      ctx.stroke();
      if (row.dashed) ctx.setLineDash([]);
      ctx.fillStyle = '#0f172a';
      ctx.fillText(row.label, lx + 28 * dpr, y);
    });
  }

  private drawRouteBreakPoints(ctx: CanvasRenderingContext2D, dpr: number, floorId?: string): void {
    const pts = floorId
      ? this.routeBreakPoints.filter((b) => b.floorId === floorId)
      : this.routeBreakPoints;
    if (pts.length === 0) return;

    const fontSize = Math.max(9, 10 * dpr);
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    for (const bp of pts) {
      const px = this.wx(bp.x);
      const py = this.wz(bp.z);
      const r = 9 * dpr;
      ctx.fillStyle = '#dc2626';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#991b1b';
      const label = bp.label.length > 36 ? `${bp.label.slice(0, 34)}…` : bp.label;
      ctx.fillText(label, px, py - r - 4 * dpr);
    }
  }

  private drawRoute(ctx: CanvasRenderingContext2D, dpr: number): void {
    const floorId = this.activeFloorId;
    if (this.routeSegments.length > 1) {
      if (!floorId) return;
      const seg = this.routeSegments.find((s) => s.floorId === floorId);
      this.drawRouteDebugForFloor(ctx, dpr, floorId);
      if (seg) {
        this.drawRouteOnPath(ctx, dpr, this.trimPathForFloor(floorId, seg.path));
      }
      this.drawRouteBreakPoints(ctx, dpr, floorId);
      return;
    }
    if (floorId) this.drawRouteDebugForFloor(ctx, dpr, floorId);
    this.drawRouteOnPath(ctx, dpr, this.path);
    this.drawRouteBreakPoints(ctx, dpr, floorId ?? undefined);
    this.drawRouteDebugLegend(ctx, dpr);
  }

  private nearestPathIndex(path: { x: number; z: number }[], x: number, z: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < path.length; i++) {
      const d = (path[i].x - x) ** 2 + (path[i].z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private trimPathForFloor(floorId: string, path: FloorPathPoint[]): FloorPathPoint[] {
    if (path.length < 2) return path;
    let out = [...path];
    for (const link of this.routeConnectors) {
      if (link.fromFloorId === floorId) {
        const idx = this.nearestPathIndex(out, link.from.x, link.from.z);
        out = out.slice(0, idx + 1);
      }
      if (link.toFloorId === floorId) {
        const idx = this.nearestPathIndex(out, link.to.x, link.to.z);
        out = out.slice(idx);
      }
    }
    return out.length >= 2 ? out : path;
  }

  private drawRouteScreenPath(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    points: { x: number; y: number }[],
  ): void {
    if (points.length < 2) return;
    const lw = Math.max(7, 8 * dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.strokeStyle = FLOOR2D_STYLE.route;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  private drawStepTicksInGap(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    path: { x: number; y: number }[],
    gapTop: number,
    gapBottom: number,
  ): void {
    const inGap = path.filter((p) => p.y >= gapTop - 1 && p.y <= gapBottom + 1);
    if (inGap.length < 2) return;
    const minY = Math.min(...inGap.map((p) => p.y));
    const maxY = Math.max(...inGap.map((p) => p.y));
    const cx = inGap.reduce((sum, p) => sum + p.x, 0) / inGap.length;
    const steps = 5;
    ctx.strokeStyle = 'rgba(37,99,235,0.4)';
    ctx.lineWidth = Math.max(1.25, 1.5 * dpr);
    for (let s = 1; s < steps; s++) {
      const y = minY + (s / steps) * (maxY - minY);
      ctx.beginPath();
      ctx.moveTo(cx - 14 * dpr, y);
      ctx.lineTo(cx + 14 * dpr, y);
      ctx.stroke();
    }
  }

  /** Stair / lift route drawn in the air gap between floor plates. */
  private drawGapStairRoutes(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    floors: FloorLevel[],
    mapH: number,
    gapPx: number,
  ): void {
    if (this.routeConnectors.length === 0) return;
    for (const link of this.routeConnectors) {
      const leaveIdx = floors.findIndex((f) => f.id === link.fromFloorId);
      const enterIdx = floors.findIndex((f) => f.id === link.toFloorId);
      if (leaveIdx < 0 || enterIdx < 0) continue;

      const leaveBounds = this.plateBounds(leaveIdx, mapH, gapPx, dpr);
      const enterBounds = this.plateBounds(enterIdx, mapH, gapPx, dpr);
      const goingUp = leaveIdx < enterIdx;
      const lowerBounds = goingUp ? leaveBounds : enterBounds;
      const upperBounds = goingUp ? enterBounds : leaveBounds;
      const lowerFloor = floors[goingUp ? leaveIdx : enterIdx];
      const upperFloor = floors[goingUp ? enterIdx : leaveIdx];

      const gapTop = upperBounds.y1 + upperBounds.dy;
      const gapBottom = lowerBounds.y0 + lowerBounds.dy;

      const exitSx = this.wx(link.from.x);
      const exitSy = this.wz(link.from.z) + leaveBounds.dy;
      const enterSx = this.wx(link.to.x);
      const enterSy = this.wz(link.to.z) + enterBounds.dy;

      const screenPts: { x: number; y: number }[] = [ { x: exitSx, y: exitSy } ];

      if (goingUp) {
        screenPts.push({ x: exitSx, y: lowerBounds.y0 + lowerBounds.dy });
        const ySpan = upperFloor.floorY - lowerFloor.floorY;
        if (link.via.length >= 2 && Math.abs(ySpan) > 1e-4) {
          for (const v of link.via) {
            const t = Math.max(0, Math.min(1, (v.y - lowerFloor.floorY) / ySpan));
            screenPts.push({ x: this.wx(v.x), y: gapBottom + t * (gapTop - gapBottom) });
          }
        } else {
          screenPts.push({ x: exitSx, y: (gapBottom + gapTop) * 0.5 });
        }
        screenPts.push({ x: enterSx, y: upperBounds.y1 + upperBounds.dy });
      } else {
        screenPts.push({ x: exitSx, y: upperBounds.y1 + upperBounds.dy });
        const ySpan = lowerFloor.floorY - upperFloor.floorY;
        if (link.via.length >= 2 && Math.abs(ySpan) > 1e-4) {
          for (const v of link.via) {
            const t = Math.max(0, Math.min(1, (v.y - upperFloor.floorY) / ySpan));
            screenPts.push({ x: this.wx(v.x), y: gapTop + t * (gapBottom - gapTop) });
          }
        } else {
          screenPts.push({ x: exitSx, y: (gapBottom + gapTop) * 0.5 });
        }
        screenPts.push({ x: enterSx, y: lowerBounds.y0 + lowerBounds.dy });
      }

      screenPts.push({ x: enterSx, y: enterSy });
      this.drawRouteScreenPath(ctx, dpr, screenPts);
      this.drawStepTicksInGap(ctx, dpr, screenPts, gapTop, gapBottom);
    }
  }

  private drawPlateSlab(
    ctx: CanvasRenderingContext2D,
    bounds: { x0: number; y0: number; x1: number; y1: number; thickness: number },
    dpr: number,
    isActive: boolean,
    title: string,
  ): void {
    const { x0, y0, x1, y1, thickness } = bounds;
    const cardW = x1 - x0;
    const cardH = y1 - y0;

    ctx.fillStyle = 'rgba(15,23,42,0.06)';
    ctx.fillRect(x0 + 3 * dpr, y1 + thickness + 2 * dpr, cardW, 5 * dpr);

    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(x0, y1, cardW, thickness);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(x0, y1, cardW, Math.max(2, thickness * 0.45));

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, cardW, cardH);

    ctx.strokeStyle = isActive ? FLOOR2D_STYLE.accent : '#94a3b8';
    ctx.lineWidth = isActive ? 2.5 * dpr : 1.5 * dpr;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, cardW - 1, cardH - 1);

    const fontSize = Math.max(10, 12 * dpr);
    ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#1e293b';
    ctx.fillText(title, x0 + 10 * dpr, y0 + 8 * dpr);
  }

  private walkForFloorLevel(floor: FloorLevel): Uint8Array | null {
    if (!this.map) return null;
    const saved = getFloorWalkGrid(this.map, floor);
    if (saved) return saved;
    if (floor.id === this.activeFloorId && this.editWalk) return this.editWalk;
    return null;
  }

  private drawPoisOnFloor(ctx: CanvasRenderingContext2D, dpr: number, floor: FloorLevel): void {
    const fontSize = Math.max(9, 11 * dpr);
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const sliceY = floor.floorY;

    const drawEndpoint = (id: string, color: string) => {
      const ep = this.resolveRouteEndpoint(id, sliceY);
      if (!ep) return;
      if (Math.abs(nearestFloorYForPoi(ep.y, this.editFloors) - floor.floorY) > 0.2) return;
      const px = this.wx(ep.x);
      const py = this.wz(ep.z);
      const label = truncateLabel(ep.name, 22);
      this.drawPoiMarker(ctx, px, py, color, dpr, 7);
      ctx.textAlign = 'center';
      ctx.fillStyle = color;
      ctx.fillText(label, px, py - 16 * dpr);
    };

    if (this.originId) drawEndpoint(this.originId, FLOOR2D_STYLE.origin);
    if (this.destId && this.destId !== this.originId) {
      drawEndpoint(this.destId, FLOOR2D_STYLE.destination);
    }

    for (const poi of this.pois) {
      if (poi.id === this.originId || poi.id === this.destId) continue;
      if (Math.abs(nearestFloorYForPoi(poi.y, this.editFloors) - floor.floorY) > 0.2) continue;
      const px = this.wx(poi.x);
      const py = this.wz(poi.z);
      const label = truncateLabel(poi.name, 22);
      this.drawPoiMarker(ctx, px, py, FLOOR2D_STYLE.poiMarker, dpr);
      ctx.textAlign = 'left';
      ctx.fillStyle = FLOOR2D_STYLE.poiLabel;
      ctx.fillText(label, px + 13 * dpr, py);
    }
  }

  private drawStackedFloorsView(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (!this.map) return;
    const floors = this.sortedFloors();
    const mapH = this.map.maxZ - this.map.minZ;
    const gapPx = this.stackGapPx(dpr);
    const pad = this.platePadPx(dpr);

    for (let i = 0; i < floors.length; i++) {
      const floor = floors[i];
      const dy = this.stackLayerDy(i, mapH, gapPx, dpr);
      const bounds = this.plateBounds(i, mapH, gapPx, dpr);
      const isActive = floor.id === this.activeFloorId;
      const preview = previewMapForFloor(this.map, floor, this.editFloors);
      const walk = this.walkForFloorLevel(floor);
      const objects = floor.objects ?? (isActive ? this.editObjects : []);
      const zones = floor.zones ?? (isActive ? this.editZones : []);
      const title = floor.label.trim() || `Floor ${i + 1}`;

      ctx.save();
      ctx.translate(0, dy);
      this.drawPlateSlab(ctx, bounds, dpr, isActive, title);

      ctx.save();
      ctx.beginPath();
      ctx.rect(bounds.x0 + pad * 0.25, bounds.y0 + pad * 0.25, bounds.x1 - bounds.x0 - pad * 0.5, bounds.y1 - bounds.y0 - pad * 0.5);
      ctx.clip();

      if (walk) this.drawWalkGrid(ctx, walk);
      this.drawStores(ctx, preview, dpr);
      this.drawWalls(ctx, preview, dpr);
      this.drawObjects(ctx, dpr, objects);
      this.drawZones(ctx, dpr, zones);

      this.drawRouteDebugForFloor(ctx, dpr, floor.id);
      const seg = this.routeSegments.find((s) => s.floorId === floor.id);
      if (seg) {
        const trimmed = this.trimPathForFloor(floor.id, seg.path);
        this.drawRouteOnPath(ctx, dpr, trimmed);
      }
      this.drawRouteBreakPoints(ctx, dpr, floor.id);

      this.drawPoisOnFloor(ctx, dpr, floor);
      ctx.restore();
      ctx.restore();
    }

    this.drawGapStairRoutes(ctx, dpr, floors, mapH, gapPx);
    this.drawRouteDebugLegend(ctx, dpr);

    if (this.routeError) {
      ctx.font = `600 ${Math.max(10, 12 * dpr)}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#b91c1c';
      ctx.fillText(this.routeError, this.canvas.width * 0.5, this.canvas.height - 18 * dpr);
    }
  }

  private drawPoiMarker(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    fill: string,
    dpr: number,
    radius = 10,
  ): void {
    const r = radius * dpr;
    ctx.fillStyle = fill;
    ctx.strokeStyle = FLOOR2D_STYLE.poiMarkerBorder;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private drawPois(ctx: CanvasRenderingContext2D, dpr: number): void {
    const fontSize = Math.max(9, 11 * dpr);
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const sliceY = this.map?.sliceY ?? 0;
    const visible = new Set(this.poisForDisplay().map((p) => p.id));

    const drawEndpoint = (id: string, color: string) => {
      const ep = this.resolveRouteEndpoint(id, sliceY);
      if (!ep) return;
      const poi = this.pois.find((p) => p.id === id);
      if (poi && !visible.has(id)) return;
      const px = this.wx(ep.x);
      const py = this.wz(ep.z);
      const label = truncateLabel(ep.name, 22);
      this.drawPoiMarker(ctx, px, py, color, dpr, 7);
      ctx.textAlign = 'center';
      ctx.fillStyle = color;
      ctx.fillText(label, px, py - 16 * dpr);
    };

    if (this.originId) drawEndpoint(this.originId, FLOOR2D_STYLE.origin);
    if (this.destId && this.destId !== this.originId) {
      drawEndpoint(this.destId, FLOOR2D_STYLE.destination);
    }
    for (const poi of this.pois) {
      if (poi.id === this.originId || poi.id === this.destId) continue;
      if (!visible.has(poi.id)) continue;
      const px = this.wx(poi.x);
      const py = this.wz(poi.z);
      const maxLen = 22;
      const label = poi.name.length > maxLen ? poi.name.slice(0, maxLen - 1) + '…' : poi.name;
      this.drawPoiMarker(ctx, px, py, FLOOR2D_STYLE.poiMarker, dpr);
      ctx.textAlign = 'left';
      ctx.fillStyle = FLOOR2D_STYLE.poiLabel;
      ctx.fillText(label, px + 13 * dpr, py);
    }
  }

  draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.map) return;
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const preview = this.previewMap();
    if (!preview) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = FLOOR2D_STYLE.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.usesStackedPlate3d()) {
      this.enableMultiFloor3dView();
      this.syncScene3d(false);
      return;
    }

    this.drawWalkGrid(ctx);
    this.drawNavMesh(ctx, dpr);
    this.drawStores(ctx, preview, dpr);
    this.drawWalls(ctx, preview, dpr);
    this.drawObjects(ctx, dpr);
    this.drawZones(ctx, dpr);
    this.drawPolygonDraft(ctx, dpr);
    this.drawDraft(ctx, dpr);
    this.drawRoute(ctx, dpr);
    this.drawPois(ctx, dpr);
    if (this.iso3d) this.syncScene3d();
  }

  dispose(): void {
    this.scene3d?.dispose();
    this.scene3d = null;
    this.zoneDialog?.remove();
    this.zoneSidebar?.remove();
    this.zoneDialog = null;
    this.zoneNameInput = null;
    this.zoneDialogOkBtn = null;
    this.zoneDialogTitle = null;
    this.zoneSidebar = null;
    this.zoneListEl = null;
    this.floorListEl = null;
    this.canvas.remove();
  }
}
