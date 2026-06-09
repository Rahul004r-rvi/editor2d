import type { AnalyzedFloorPlan } from './floorPlan';
import { MAPPEDIN_STYLE } from './floorPlan';
import type { NavMapPoi } from './pois';

/**
 * Mappedin / Pointr-style 2.5D floor renderer:
 * white floors, extruded gray walls, clean room partitions.
 */
export class MappedinStyleView {
  readonly canvas: HTMLCanvasElement;
  private plan: AnalyzedFloorPlan | null = null;
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

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'display:block;width:100%;height:100%;touch-action:none;cursor:grab;background:' +
      MAPPEDIN_STYLE.background +
      ';';
    parent.appendChild(this.canvas);
    this.bindPanZoom();
  }

  private bindPanZoom(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.offsetX += e.clientX - this.lastX;
      this.offsetY += e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.draw();
    });
    const end = () => {
      this.dragging = false;
      this.canvas.style.cursor = 'grab';
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
  }

  setPlan(plan: AnalyzedFloorPlan): void {
    this.plan = plan;
    this.fit();
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
    if (!this.plan) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    const b = this.plan.bounds;
    const mapW = b.maxX - b.minX;
    const mapH = b.maxZ - b.minZ;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    const pad = MAPPEDIN_STYLE.wallHeightPx * 2;
    this.scale = Math.min((w * 0.9) / mapW, (h * 0.9 - pad) / mapH) * dpr;
    this.offsetX = (this.canvas.width - mapW * this.scale) / 2 - b.minX * this.scale;
    this.offsetY = (this.canvas.height - mapH * this.scale) / 2 - b.minZ * this.scale + pad * 0.5;
  }

  private wx(x: number): number {
    return x * this.scale + this.offsetX;
  }

  private wz(z: number): number {
    return z * this.scale + this.offsetY;
  }

  private drawPolygon(ctx: CanvasRenderingContext2D, poly: [number, number][], fill: string, stroke?: string): void {
    if (poly.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(this.wx(poly[0][0]), this.wz(poly[0][1]));
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(this.wx(poly[i][0]), this.wz(poly[i][1]));
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(0.5, 0.6 * (this.canvas.width / Math.max(1, this.canvas.clientWidth)));
      ctx.stroke();
    }
  }

  private drawExtrudedWall(
    ctx: CanvasRenderingContext2D,
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    dpr: number,
  ): void {
    const h = MAPPEDIN_STYLE.wallHeightPx * dpr;
    const px1 = this.wx(x1);
    const pz1 = this.wz(z1);
    const px2 = this.wx(x2);
    const pz2 = this.wz(z2);
    const dx = px2 - px1;
    const dz = pz2 - pz1;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * (h * 0.35);
    const ny = (dx / len) * (h * 0.35);

    ctx.fillStyle = MAPPEDIN_STYLE.wallFace;
    ctx.beginPath();
    ctx.moveTo(px1, pz1);
    ctx.lineTo(px2, pz2);
    ctx.lineTo(px2 + nx, pz2 - h + ny);
    ctx.lineTo(px1 + nx, pz1 - h + ny);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = MAPPEDIN_STYLE.wallEdge;
    ctx.lineWidth = Math.max(1, 1.1 * dpr);
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(px1 + nx, pz1 - h + ny);
    ctx.lineTo(px2 + nx, pz2 - h + ny);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(px1, pz1);
    ctx.lineTo(px2, pz2);
    ctx.stroke();
  }

  draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.plan) return;
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const p = this.plan;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = MAPPEDIN_STYLE.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    for (const poly of p.floors) {
      this.drawPolygon(ctx, poly, MAPPEDIN_STYLE.floor);
    }
    for (const poly of p.corridors) {
      this.drawPolygon(ctx, poly, MAPPEDIN_STYLE.corridor);
    }
    for (const room of p.rooms) {
      this.drawPolygon(ctx, room.polygon, MAPPEDIN_STYLE.floor, MAPPEDIN_STYLE.wallEdge);
    }

    for (const obs of p.obstacles) {
      const x = this.wx(obs.x);
      const y = this.wz(obs.z);
      const w = obs.w * this.scale;
      const h = obs.d * this.scale;
      const wh = MAPPEDIN_STYLE.wallHeightPx * dpr * 0.6;
      ctx.fillStyle = MAPPEDIN_STYLE.obstacle;
      ctx.fillRect(x, y - wh, w, h);
      ctx.fillStyle = MAPPEDIN_STYLE.obstacleEdge;
      ctx.fillRect(x, y - wh, w, 2 * dpr);
      ctx.strokeStyle = MAPPEDIN_STYLE.wallEdge;
      ctx.lineWidth = Math.max(0.75, 1 * dpr);
      ctx.strokeRect(x, y - wh, w, h);
    }

    for (const w of p.walls) {
      this.drawExtrudedWall(ctx, w.x1, w.z1, w.x2, w.z2, dpr);
    }

    if (this.path.length >= 2) {
      ctx.strokeStyle = MAPPEDIN_STYLE.route;
      ctx.lineWidth = Math.max(4, 5 * dpr);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(this.wx(this.path[0].x), this.wz(this.path[0].z));
      for (let i = 1; i < this.path.length; i++) {
        ctx.lineTo(this.wx(this.path[i].x), this.wz(this.path[i].z));
      }
      ctx.stroke();
    }

    const fontSize = Math.max(8, 9 * dpr);
    ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const poi of this.pois) {
      const px = this.wx(poi.x);
      const py = this.wz(poi.z);
      const isO = poi.id === this.originId;
      const isD = poi.id === this.destId;
      const color = isO ? MAPPEDIN_STYLE.origin : isD ? MAPPEDIN_STYLE.destination : MAPPEDIN_STYLE.poiLabel;
      if (isO || isD) {
        ctx.fillStyle = color;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.arc(px, py, 5 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.fillText(poi.name, px, py - (isO || isD ? 14 : 0) * dpr);
    }
  }

  dispose(): void {
    this.canvas.remove();
  }
}
