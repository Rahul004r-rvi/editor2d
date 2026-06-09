import type { NavMesh } from 'recast-navigation';
import { parseZoneRouteId, type NavMapPoi } from './pois';
import { buildFloorEditPayload, type NavmeFloorEditPayload } from './data/floorEditPayload';
import {
  applyWalkGridEdits,
  FLOOR2D_STYLE,
  nextZoneStrokeColor,
  paintRectOnWalk,
  walkGridFromBlocks,
  zoneDisplayLabel,
  type Floor2DMap,
  type FloorBlock,
  type FloorShape,
} from './floor2d';
import { extractNavMeshSlice2D, type NavMeshSliceTri } from './navmesh2d';
import {
  boundsFromPoints,
  cloneZonePoints,
  dist2,
  isPolygonZone,
  pointInsideZone,
  resizeRectZone,
  syncZoneBounds,
  translateZone,
  zoneCentroid,
  type ZoneEditHandle,
  type ZonePoint,
} from './zoneGeometry';

export type Floor2DViewOptions = {
  onPoiClick?: (poi: NavMapPoi) => void;
};

export type Floor2DTool = 'pan' | 'add' | 'cut' | 'object' | 'zone' | 'zone-edit';
export type ZoneDrawMode = 'rectangle' | 'polygon';

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

function cloneZoneBlock(block: FloorBlock): FloorBlock {
  return {
    ...block,
    points: cloneZonePoints(block.points),
  };
}

function truncateLabel(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

export class Floor2DView {
  readonly canvas: HTMLCanvasElement;
  private map: Floor2DMap | null = null;
  private editWalk: Uint8Array | null = null;
  private editObjects: FloorBlock[] = [];
  private editZones: FloorBlock[] = [];
  private objectShape: FloorShape = 'rectangle';
  private tool: Floor2DTool = 'pan';
  private dirty = false;
  private draft: { x0: number; z0: number; x1: number; z1: number } | null = null;
  private path: { x: number; z: number }[] = [];
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
  private undoStack: EditSnapshot[] = [];
  private redoStack: EditSnapshot[] = [];
  private showNavMesh = false;
  private navMeshTris: NavMeshSliceTri[] = [];
  private onToolChange?: (tool: Floor2DTool) => void;
  private onDirtyChange?: (dirty: boolean) => void;
  private onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
  private onZonesChange?: () => void;
  private onRouteRebuild?: () => void;
  private zoneDialog: HTMLDivElement | null = null;
  private zoneNameInput: HTMLInputElement | null = null;
  private zoneDialogResolve: ((name: string | null) => void) | null = null;
  private zoneSidebar: HTMLElement | null = null;
  private zoneListEl: HTMLElement | null = null;
  private zoneDrawMode: ZoneDrawMode = 'rectangle';
  private selectedZoneId: string | null = null;
  private polygonDraft: { points: ZonePoint[]; cursorX: number; cursorZ: number } | null = null;
  private zoneEdit: {
    zone: FloorBlock;
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
    this.buildZoneNameDialog(parent);
    this.bindPointer();
    this.bindKeyboard();
  }

  private buildZoneSidebar(mapParent: HTMLElement): void {
    const layout = mapParent.parentElement;
    if (!layout) return;
    layout.classList.add('floor2d-layout');

    const sidebar = document.createElement('aside');
    sidebar.className = 'floor2d-zone-sidebar';

    const header = document.createElement('div');
    header.className = 'floor2d-zone-sidebar__header';
    header.textContent = 'Zones';

    const hint = document.createElement('div');
    hint.className = 'floor2d-zone-sidebar__hint';
    hint.textContent = 'Click a zone to zoom — use Edit Zone to move dots';

    const list = document.createElement('div');
    list.className = 'floor2d-zone-list';

    sidebar.append(header, hint, list);
    layout.insertBefore(sidebar, mapParent);

    this.zoneSidebar = sidebar;
    this.zoneListEl = list;
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

  private askZoneName(defaultName = '', mode: 'create' | 'rename' = 'create'): Promise<string | null> {
    if (!this.zoneDialog || !this.zoneNameInput || !this.zoneDialogOkBtn || !this.zoneDialogTitle) {
      return Promise.resolve(defaultName.trim() || null);
    }
    this.zoneDialogTitle.textContent = mode === 'rename' ? 'Rename zone' : 'Zone name';
    this.zoneDialogOkBtn.textContent = mode === 'rename' ? 'Save' : 'Add Zone';
    this.zoneNameInput.value = defaultName;
    this.zoneDialog.style.display = 'flex';
    this.zoneNameInput.focus();
    this.zoneNameInput.select();
    return new Promise((resolve) => {
      this.zoneDialogResolve = resolve;
    });
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
    this.refreshZoneSidebar();
    this.draw();
  }

  focusZone(zone: FloorBlock): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const vw = Math.max(1, parent.clientWidth);
    const vh = Math.max(1, parent.clientHeight);
    const pad = 48;
    const zoomW = Math.max(zone.w, 0.5);
    const zoomH = Math.max(zone.d, 0.5);
    const c = zoneCentroid(zone);
    this.canvas.width = Math.floor(vw * dpr);
    this.canvas.height = Math.floor(vh * dpr);
    this.scale = Math.min((vw - pad) / zoomW, (vh - pad) / zoomH) * dpr;
    this.offsetX = this.canvas.width / 2 - c.x * this.scale;
    this.offsetY = this.canvas.height / 2 - c.z * this.scale;
    this.draw();
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
      if (zone.id === this.selectedZoneId) btn.classList.add('floor2d-zone-item--active');

      const dot = document.createElement('span');
      dot.className = 'floor2d-zone-item__dot';
      dot.style.background = zone.stroke || FLOOR2D_STYLE.accent;

      const name = document.createElement('span');
      name.className = 'floor2d-zone-item__name';
      name.textContent = zone.label.trim() || 'Untitled zone';

      btn.append(dot, name);
      btn.addEventListener('click', () => {
        this.setTool('zone-edit');
        this.selectZone(zone.id);
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

  setOnRouteRebuild(fn: () => void): void {
    this.onRouteRebuild = fn;
  }

  /** Zones available as origin/destination (navigate to center point). */
  getRouteZones(): { id: string; label: string }[] {
    return this.editZones.map((z) => ({
      id: z.id,
      label: z.label.trim() || 'Untitled zone',
    }));
  }

  resolveRouteEndpoint(
    id: string,
    sliceY: number,
  ): { x: number; y: number; z: number; name: string } | null {
    const zoneId = parseZoneRouteId(id);
    if (zoneId) {
      const zone = this.editZones.find((z) => z.id === zoneId);
      if (!zone) return null;
      const c = zoneCentroid(zone);
      return { x: c.x, y: sliceY, z: c.z, name: zone.label.trim() || 'Untitled zone' };
    }
    const poi = this.pois.find((p) => p.id === id);
    if (poi) return { x: poi.x, y: poi.y, z: poi.z, name: poi.name };
    return null;
  }

  private notifyZonesChange(): void {
    this.onZonesChange?.();
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
    this.map = applyWalkGridEdits(this.map, this.editWalk, this.editObjects, this.editZones);
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
    return buildFloorEditPayload(this.map, this.editWalk, this.editObjects, this.editZones, sliceY, mapCode);
  }

  getEditStateForSave(): { map: Floor2DMap; walk: Uint8Array; objects: FloorBlock[]; zones: FloorBlock[] } | null {
    if (!this.map || !this.editWalk) return null;
    return {
      map: this.map,
      walk: this.editWalk,
      objects: cloneBlocks(this.editObjects),
      zones: cloneBlocks(this.editZones),
    };
  }

  setMap(map: Floor2DMap): void {
    this.map = map;
    const blocks = map.corridors.length > 0 ? map.corridors : map.blocks;
    this.editWalk = walkGridFromBlocks(map, blocks);
    this.editObjects = cloneBlocks(map.objects ?? []);
    this.editZones = cloneBlocks(map.zones ?? []);
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
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.draw();
  }

  setPath(points: { x: number; y: number; z: number }[]): void {
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
    this.draw();
  }

  fit(): void {
    if (!this.map) return;
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
    return applyWalkGridEdits(this.map, this.editWalk, this.editObjects, this.editZones);
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
    const sx = (clientX - rect.left) * dpr;
    const sy = (clientY - rect.top) * dpr;
    return { x: (sx - this.offsetX) / this.scale, z: (sy - this.offsetY) / this.scale };
  }

  private handleRadiusWorld(): number {
    return HANDLE_RADIUS_PX / Math.max(this.scale, 0.001);
  }

  private hitZoneHandle(x: number, z: number): { zone: FloorBlock; handle: ZoneEditHandle } | null {
    if (!this.isZoneEditTool()) return null;
    const thresh = this.handleRadiusWorld() ** 2;
    const selected = this.editZones.find((z) => z.id === this.selectedZoneId);
    const zones = selected
      ? [selected, ...this.editZones.filter((z) => z.id !== selected.id)]
      : [...this.editZones];

    for (const zone of zones) {
      if (isPolygonZone(zone) && zone.points) {
        for (let i = 0; i < zone.points.length; i++) {
          const p = zone.points[i];
          if (dist2(x, z, p.x, p.z) <= thresh) {
            this.selectZone(zone.id);
            return { zone, handle: { kind: 'vertex', index: i } };
          }
        }
        continue;
      }

      const corners = [
        { corner: 'nw' as const, x: zone.x, z: zone.z },
        { corner: 'ne' as const, x: zone.x + zone.w, z: zone.z },
        { corner: 'sw' as const, x: zone.x, z: zone.z + zone.d },
        { corner: 'se' as const, x: zone.x + zone.w, z: zone.z + zone.d },
      ];
      for (const c of corners) {
        if (dist2(x, z, c.x, c.z) <= thresh) {
          this.selectZone(zone.id);
          return { zone, handle: { kind: 'resize', corner: c.corner } };
        }
      }
    }
    return null;
  }

  private applyZoneEdit(x: number, z: number): void {
    if (!this.zoneEdit) return;
    const { zone, handle, startWorld, snapshot } = this.zoneEdit;
    const dx = x - startWorld.x;
    const dz = z - startWorld.z;

    if (handle.kind === 'move') {
      if (isPolygonZone(snapshot) && snapshot.points) {
        zone.points = cloneZonePoints(snapshot.points)!;
        translateZone(zone, dx, dz);
      } else {
        zone.x = snapshot.x + dx;
        zone.z = snapshot.z + dz;
        zone.w = snapshot.w;
        zone.d = snapshot.d;
      }
      return;
    }

    if (handle.kind === 'vertex' && snapshot.points) {
      zone.points = cloneZonePoints(snapshot.points)!;
      zone.points[handle.index].x = snapshot.points[handle.index].x + dx;
      zone.points[handle.index].z = snapshot.points[handle.index].z + dz;
      syncZoneBounds(zone);
      return;
    }

    if (handle.kind === 'resize') {
      zone.x = snapshot.x;
      zone.z = snapshot.z;
      zone.w = snapshot.w;
      zone.d = snapshot.d;
      resizeRectZone(zone, handle.corner, x, z);
    }
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

      if (!this.isZoneEditTool()) return;

      if (e.key === 'Escape') {
        this.zoneEdit = null;
        this.selectZone(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedZoneId) {
        e.preventDefault();
        this.pushHistory();
        this.editZones = this.editZones.filter((z) => z.id !== this.selectedZoneId);
        this.selectZone(null);
        this.refreshZoneSidebar();
        this.notifyZonesChange();
        this.draw();
      }
    });
  }

  private beginZoneEditPointer(w: { x: number; z: number }): boolean {
    const handleHit = this.hitZoneHandle(w.x, w.z);
    if (handleHit) {
      this.zoneEdit = {
        zone: handleHit.zone,
        handle: handleHit.handle,
        startWorld: w,
        snapshot: cloneZoneBlock(handleHit.zone),
        historyPushed: false,
      };
      this.canvas.style.cursor = 'grabbing';
      return true;
    }

    const zoneHit = this.hitTestZone(w.x, w.z);
    if (zoneHit) {
      this.selectZone(zoneHit.id);
      this.zoneEdit = {
        zone: zoneHit,
        handle: { kind: 'move' },
        startWorld: w,
        snapshot: cloneZoneBlock(zoneHit),
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
      if (!this.map || !this.isZoneEditTool()) return;
      const w = this.screenToWorld(e.clientX, e.clientY);
      const zoneHit = this.hitTestZone(w.x, w.z);
      if (zoneHit) {
        void (async () => {
          const name = await this.askZoneName(zoneHit.label, 'rename');
          if (name && name !== zoneHit.label) {
            this.pushHistory();
            zoneHit.label = name;
            this.refreshZoneSidebar();
          }
          this.draw();
        })();
      }
    });
  }

  private hitTestZone(x: number, z: number): FloorBlock | null {
    for (let i = this.editZones.length - 1; i >= 0; i--) {
      if (pointInsideZone(x, z, this.editZones[i])) return this.editZones[i];
    }
    return null;
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

  private drawWalkGrid(ctx: CanvasRenderingContext2D): void {
    if (!this.map || !this.editWalk) return;
    const { minX, minZ, cellSize, cols, rows } = this.map;
    const cellPx = cellSize * this.scale;
    ctx.fillStyle = FLOOR2D_STYLE.corridor;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!this.editWalk[r * cols + c]) continue;
        const x = minX + c * cellSize;
        const z = minZ + r * cellSize;
        ctx.fillRect(this.wx(x), this.wz(z), cellPx, cellPx);
      }
    }
  }

  private drawObjects(ctx: CanvasRenderingContext2D, dpr: number): void {
    const lineW = Math.max(1.25, 1.5 * dpr);
    for (const b of this.editObjects) {
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

  private drawPolygonDraft(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (!this.polygonDraft || this.polygonDraft.points.length === 0) return;
    const pts = this.polygonDraft.points;
    const stroke = FLOOR2D_STYLE.accent;
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(2, 2.5 * dpr);
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(this.wx(pts[0].x), this.wz(pts[0].z));
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(this.wx(pts[i].x), this.wz(pts[i].z));
    }
    ctx.lineTo(this.wx(this.polygonDraft.cursorX), this.wz(this.polygonDraft.cursorZ));
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

  private drawZones(ctx: CanvasRenderingContext2D, dpr: number): void {
    const lineW = Math.max(2, 2.5 * dpr);
    for (const b of this.editZones) {
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
      this.drawZoneLabel(ctx, x, y, w, h, zoneDisplayLabel(b, this.pois), dpr);
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

  private drawRoute(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (this.path.length < 2) return;
    const lw = Math.max(4, 5 * dpr);
    const outline = lw + 2.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(this.wx(this.path[0].x), this.wz(this.path[0].z));
    for (let i = 1; i < this.path.length; i++) {
      ctx.lineTo(this.wx(this.path[i].x), this.wz(this.path[i].z));
    }
    ctx.strokeStyle = FLOOR2D_STYLE.routeOutline;
    ctx.lineWidth = outline;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(this.wx(this.path[0].x), this.wz(this.path[0].z));
    for (let i = 1; i < this.path.length; i++) {
      ctx.lineTo(this.wx(this.path[i].x), this.wz(this.path[i].z));
    }
    ctx.strokeStyle = FLOOR2D_STYLE.route;
    ctx.lineWidth = lw;
    ctx.stroke();
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

    const drawEndpoint = (id: string, color: string) => {
      const ep = this.resolveRouteEndpoint(id, sliceY);
      if (!ep) return;
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
  }

  dispose(): void {
    this.zoneDialog?.remove();
    this.zoneSidebar?.remove();
    this.zoneDialog = null;
    this.zoneNameInput = null;
    this.zoneDialogOkBtn = null;
    this.zoneDialogTitle = null;
    this.zoneSidebar = null;
    this.zoneListEl = null;
    this.canvas.remove();
  }
}
