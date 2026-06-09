"""
Geometric floor-plan extraction from GLB meshes (Mappedin / Pointr style).

Pipeline:
  1. Slice horizontal faces near Y
  2. Rasterize walkable occupancy grid
  3. Morphological cleanup (close gaps, remove noise)
  4. Distance transform → corridor vs room classification
  5. Contour extraction → floor polygons, wall segments, interior obstacles
"""

from __future__ import annotations

import io
from typing import Any

import cv2
import numpy as np
import trimesh
from scipy import ndimage


def _load_mesh(glb_bytes: bytes) -> trimesh.Trimesh:
    loaded = trimesh.load(io.BytesIO(glb_bytes), file_type="glb", force="mesh")
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise ValueError("GLB contains no mesh geometry")
        return trimesh.util.concatenate(meshes)
    if not isinstance(loaded, trimesh.Trimesh):
        raise ValueError("Unsupported GLB content")
    return loaded


def _point_in_tri(px: float, pz: float, ax: float, az: float, bx: float, bz: float, cx: float, cz: float) -> bool:
    v0x, v0z = cx - ax, cz - az
    v1x, v1z = bx - ax, bz - az
    v2x, v2z = px - ax, pz - az
    dot00 = v0x * v0x + v0z * v0z
    dot01 = v0x * v1x + v0z * v1z
    dot02 = v0x * v2x + v0z * v2z
    dot11 = v1x * v1x + v1z * v1z
    dot12 = v1x * v2x + v1z * v2z
    inv = dot00 * dot11 - dot01 * dot01
    if abs(inv) < 1e-12:
        return False
    u = (dot11 * dot02 - dot01 * dot12) / inv
    v = (dot00 * dot12 - dot01 * dot02) / inv
    return u >= 0 and v >= 0 and u + v <= 1


def _rasterize_tri(
    grid: np.ndarray,
    cols: int,
    rows: int,
    min_x: float,
    min_z: float,
    cell: float,
    ax: float,
    az: float,
    bx: float,
    bz: float,
    cx: float,
    cz: float,
) -> None:
    tmin_x = min(ax, bx, cx)
    tmax_x = max(ax, bx, cx)
    tmin_z = min(az, bz, cz)
    tmax_z = max(az, bz, cz)
    c0 = max(0, int((tmin_x - min_x) / cell))
    c1 = min(cols - 1, int((tmax_x - min_x) / cell))
    r0 = max(0, int((tmin_z - min_z) / cell))
    r1 = min(rows - 1, int((tmax_z - min_z) / cell))
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            px = min_x + (c + 0.5) * cell
            pz = min_z + (r + 0.5) * cell
            if _point_in_tri(px, pz, ax, az, bx, bz, cx, cz):
                grid[r, c] = 1


def _contour_to_polygon(cnt: np.ndarray, min_x: float, min_z: float, cell: float, simplify: float = 2.0) -> list[list[float]]:
    approx = cv2.approxPolyDP(cnt, simplify * cell * 0.35, True)
    poly: list[list[float]] = []
    for pt in approx:
        x = min_x + float(pt[0][0] + 0.5) * cell
        z = min_z + float(pt[0][1] + 0.5) * cell
        poly.append([round(x, 4), round(z, 4)])
    if len(poly) >= 2 and poly[0] == poly[-1]:
        poly.pop()
    return poly


def _extract_walls(walk: np.ndarray, cols: int, rows: int, min_x: float, min_z: float, cell: float) -> list[dict[str, float]]:
    walls: list[dict[str, float]] = []
    for r in range(rows):
        for c in range(cols + 1):
            left = walk[r, c - 1] if c > 0 else 0
            right = walk[r, c] if c < cols else 0
            if left != right:
                x = min_x + c * cell
                z0 = min_z + r * cell
                z1 = min_z + (r + 1) * cell
                walls.append(_wall_seg(x, z0, x, z1))
    for r in range(rows + 1):
        for c in range(cols):
            up = walk[r - 1, c] if r > 0 else 0
            down = walk[r, c] if r < rows else 0
            if up != down:
                z = min_z + r * cell
                x0 = min_x + c * cell
                x1 = min_x + (c + 1) * cell
                walls.append(_wall_seg(x0, z, x1, z))
    return _merge_segments(walls)


def _find_obstacles(interior: np.ndarray, min_x: float, min_z: float, cell: float, min_cells: int = 2) -> list[dict[str, float]]:
    obstacles: list[dict[str, float]] = []
    num, labels, stats, _ = cv2.connectedComponentsWithStats(interior.astype(np.uint8), connectivity=8)
    for label in range(1, num):
        area = stats[label, cv2.CC_STAT_AREA]
        if area < min_cells:
            continue
        x = stats[label, cv2.CC_STAT_LEFT]
        y = stats[label, cv2.CC_STAT_TOP]
        w = stats[label, cv2.CC_STAT_WIDTH]
        h = stats[label, cv2.CC_STAT_HEIGHT]
        obstacles.append(
            {
                "x": round(_f(min_x + x * cell), 4),
                "z": round(_f(min_z + y * cell), 4),
                "w": round(_f(w * cell), 4),
                "d": round(_f(h * cell), 4),
            }
        )
    return obstacles


def _f(value: Any) -> float:
    return float(value)


def _wall_seg(x1: float, z1: float, x2: float, z2: float) -> dict[str, float]:
    return {"x1": _f(x1), "z1": _f(z1), "x2": _f(x2), "z2": _f(z2)}


def _merge_segments(segs: list[dict[str, float]], eps: float = 1e-4) -> list[dict[str, float]]:
    horiz: list[tuple[float, float, float]] = []
    vert: list[tuple[float, float, float]] = []
    for s in segs:
        if abs(s["z1"] - s["z2"]) < eps:
            horiz.append((s["z1"], min(s["x1"], s["x2"]), max(s["x1"], s["x2"])))
        elif abs(s["x1"] - s["x2"]) < eps:
            vert.append((s["x1"], min(s["z1"], s["z2"]), max(s["z1"], s["z2"])))
    horiz.sort()
    vert.sort()
    merged_h: list[tuple[float, float, float]] = []
    for z, x0, x1 in horiz:
        if merged_h and abs(merged_h[-1][0] - z) < eps and x0 <= merged_h[-1][2] + eps:
            merged_h[-1] = (z, merged_h[-1][1], max(merged_h[-1][2], x1))
        else:
            merged_h.append((z, x0, x1))
    merged_v: list[tuple[float, float, float]] = []
    for x, z0, z1 in vert:
        if merged_v and abs(merged_v[-1][0] - x) < eps and z0 <= merged_v[-1][2] + eps:
            merged_v[-1] = (x, merged_v[-1][1], max(merged_v[-1][2], z1))
        else:
            merged_v.append((x, z0, z1))
    out: list[dict[str, float]] = []
    for z, x0, x1 in merged_h:
        out.append(_wall_seg(x0, z, x1, z))
    for x, z0, z1 in merged_v:
        out.append(_wall_seg(x, z0, x, z1))
    return out


def _empty_plan(slice_y: float, cell_size: float, min_x: float, max_x: float, min_z: float, max_z: float) -> dict[str, Any]:
    return {
        "version": 1,
        "sliceY": _f(slice_y),
        "cellSize": _f(cell_size),
        "bounds": {
            "minX": round(_f(min_x), 4),
            "maxX": round(_f(max_x), 4),
            "minZ": round(_f(min_z), 4),
            "maxZ": round(_f(max_z), 4),
        },
        "floors": [],
        "corridors": [],
        "rooms": [],
        "walls": [],
        "obstacles": [],
    }


def analyze_triangles(
    triangles: list[float],
    slice_y: float = -1.6,
    cell_size: float = 0.1,
    band: float = 0.45,
    corridor_min_width: float = 1.0,
) -> dict[str, Any]:
    """Analyze decoded floor triangles from the browser (Draco-safe)."""
    if len(triangles) < 9:
        return _empty_plan(slice_y, cell_size, -10, 10, -10, 10)

    tris = np.asarray(triangles, dtype=np.float64).reshape(-1, 3, 3)
    pad = 0.5
    min_x = _f(tris[:, :, 0].min()) - pad
    max_x = _f(tris[:, :, 0].max()) + pad
    min_z = _f(tris[:, :, 2].min()) - pad
    max_z = _f(tris[:, :, 2].max()) + pad

    max_dim = 1500
    span_x = max_x - min_x
    span_z = max_z - min_z
    if span_x / cell_size > max_dim or span_z / cell_size > max_dim:
        cell_size = max(cell_size, span_x / max_dim, span_z / max_dim)

    cols = max(1, int(np.ceil((max_x - min_x) / cell_size)))
    rows = max(1, int(np.ceil((max_z - min_z) / cell_size)))
    walk = np.zeros((rows, cols), dtype=np.uint8)

    for tri in tris:
        y_min, y_max = tri[:, 1].min(), tri[:, 1].max()
        if y_max < slice_y - band or y_min > slice_y + band:
            continue
        ab = tri[1] - tri[0]
        ac = tri[2] - tri[0]
        n = np.cross(ab, ac)
        norm = np.linalg.norm(n)
        if norm < 1e-12:
            continue
        if n[1] / norm > 0.35:
            _rasterize_tri(
                walk,
                cols,
                rows,
                min_x,
                min_z,
                cell_size,
                tri[0, 0],
                tri[0, 2],
                tri[1, 0],
                tri[1, 2],
                tri[2, 0],
                tri[2, 2],
            )

    if walk.sum() == 0:
        for tri in tris:
            y_min, y_max = tri[:, 1].min(), tri[:, 1].max()
            if y_max < slice_y - band or y_min > slice_y + band:
                continue
            _rasterize_tri(
                walk,
                cols,
                rows,
                min_x,
                min_z,
                cell_size,
                tri[0, 0],
                tri[0, 2],
                tri[1, 0],
                tri[1, 2],
                tri[2, 0],
                tri[2, 2],
            )

    if walk.sum() == 0:
        return _empty_plan(slice_y, cell_size, min_x, max_x, min_z, max_z)

    return _finalize_walk_grid(
        walk, cols, rows, min_x, max_x, min_z, max_z, slice_y, cell_size, corridor_min_width
    )


def _finalize_walk_grid(
    walk: np.ndarray,
    cols: int,
    rows: int,
    min_x: float,
    max_x: float,
    min_z: float,
    max_z: float,
    slice_y: float,
    cell_size: float,
    corridor_min_width: float,
) -> dict[str, Any]:

    kernel = np.ones((3, 3), np.uint8)
    walk = cv2.morphologyEx(walk, cv2.MORPH_CLOSE, kernel, iterations=2)
    walk = cv2.morphologyEx(walk, cv2.MORPH_OPEN, kernel, iterations=1)

    dist_px = cv2.distanceTransform(walk, cv2.DIST_L2, 5)
    corridor_px = max(1, int(corridor_min_width / cell_size * 0.5))
    corridor_mask = (walk > 0) & (dist_px >= corridor_px)
    room_adjacent = np.zeros_like(walk)
    for r in range(rows):
        for c in range(cols):
            if walk[r, c]:
                continue
            for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                nr, nc = r + dr, c + dc
                if 0 <= nr < rows and 0 <= nc < cols and walk[nr, nc]:
                    room_adjacent[r, c] = 1
                    break

    interior_obstacles = (walk == 0) & ndimage.binary_fill_holes(walk.astype(bool))
    interior_obstacles = interior_obstacles & (~room_adjacent.astype(bool))
    obstacle_mask = interior_obstacles.astype(np.uint8)
    obstacle_mask = cv2.morphologyEx(obstacle_mask, cv2.MORPH_OPEN, kernel, iterations=1)

    walls = _extract_walls(walk, cols, rows, min_x, min_z, cell_size)

    floor_polygons: list[list[list[float]]] = []
    contours, _ = cv2.findContours(walk, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    for cnt in contours:
        if cv2.contourArea(cnt) < cell_size * cell_size * 4:
            continue
        poly = _contour_to_polygon(cnt, min_x, min_z, cell_size)
        if len(poly) >= 3:
            floor_polygons.append(poly)

    corridor_polygons: list[list[list[float]]] = []
    corridor_u8 = corridor_mask.astype(np.uint8)
    if corridor_u8.sum() > 0:
        c_contours, _ = cv2.findContours(corridor_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        for cnt in c_contours:
            if cv2.contourArea(cnt) < cell_size * cell_size * 8:
                continue
            poly = _contour_to_polygon(cnt, min_x, min_z, cell_size)
            if len(poly) >= 3:
                corridor_polygons.append(poly)

    room_polygons: list[dict[str, Any]] = []
    room_u8 = room_adjacent.astype(np.uint8)
    r_contours, _ = cv2.findContours(room_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    rid = 0
    for cnt in r_contours:
        if cv2.contourArea(cnt) < cell_size * cell_size * 2:
            continue
        poly = _contour_to_polygon(cnt, min_x, min_z, cell_size)
        if len(poly) >= 3:
            room_polygons.append({"id": f"room-{rid}", "polygon": poly, "label": ""})
            rid += 1

    obstacles = _find_obstacles(obstacle_mask, min_x, min_z, cell_size)

    return {
        "version": 1,
        "sliceY": _f(slice_y),
        "cellSize": _f(cell_size),
        "bounds": {
            "minX": round(_f(min_x), 4),
            "maxX": round(_f(max_x), 4),
            "minZ": round(_f(min_z), 4),
            "maxZ": round(_f(max_z), 4),
        },
        "floors": floor_polygons,
        "corridors": corridor_polygons,
        "rooms": room_polygons,
        "walls": walls,
        "obstacles": obstacles,
    }


def analyze_glb_bytes(
    glb_bytes: bytes,
    slice_y: float = -1.6,
    cell_size: float = 0.1,
    band: float = 0.45,
    corridor_min_width: float = 1.0,
) -> dict[str, Any]:
    """Load GLB in Python (non-Draco meshes only). Prefer analyze_triangles from browser."""
    mesh = _load_mesh(glb_bytes)
    vertices = mesh.vertices
    faces = mesh.faces
    flat: list[float] = []
    for face in faces:
        tri = vertices[face]
        flat.extend(
            [
                _f(tri[0, 0]), _f(tri[0, 1]), _f(tri[0, 2]),
                _f(tri[1, 0]), _f(tri[1, 1]), _f(tri[1, 2]),
                _f(tri[2, 0]), _f(tri[2, 1]), _f(tri[2, 2]),
            ]
        )
    return analyze_triangles(flat, slice_y=slice_y, cell_size=cell_size, band=band, corridor_min_width=corridor_min_width)
