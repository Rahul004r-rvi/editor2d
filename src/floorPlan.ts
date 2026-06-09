/** Floor plan JSON from Python structure analyzer (Mappedin-style). */

export type FloorPlanBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type FloorPlanWall = { x1: number; z1: number; x2: number; z2: number };

export type FloorPlanRoom = {
  id: string;
  polygon: [number, number][];
  label: string;
};

export type FloorPlanObstacle = { x: number; z: number; w: number; d: number };

export type AnalyzedFloorPlan = {
  version: number;
  sliceY: number;
  cellSize: number;
  bounds: FloorPlanBounds;
  floors: [number, number][][];
  corridors: [number, number][][];
  rooms: FloorPlanRoom[];
  walls: FloorPlanWall[];
  obstacles: FloorPlanObstacle[];
};

export const MAPPEDIN_STYLE = {
  background: '#f5f5f5',
  floor: '#f5f5f5',
  corridor: '#f5f5f5',
  wallFace: '#e0e0e0',
  wallTop: '#d3d3d3',
  wallEdge: '#999999',
  obstacle: '#ffffff',
  obstacleEdge: '#999999',
  route: '#3b6fd9',
  routeOutline: '#ffffff',
  poiLabel: '#9c27b0',
  origin: '#4caf50',
  destination: '#9c27b0',
  wallHeightPx: 7,
} as const;
