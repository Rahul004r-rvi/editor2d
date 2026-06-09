# NavMe Mini 3D GTA

Standalone 3D indoor navigation: MultiSet GLB map, Recast nav mesh, route + breadcrumbs.

## Features

- **NavMe logo button** (top-left) — tap to open fullscreen 3D map
- **MultiSet** map load via M2M auth (`MAP_*` code)
- **Supabase edge proxy** for browser-safe API calls (no CloudFront 403)
- **Draco** compressed GLB support
- **Recast** walkable nav mesh (0.02 m agent radius)
- **Origin / Destination** dropdowns with demo POIs from map bounds
- Red path line + breadcrumb trail on the nav mesh

## Quick start

```bash
./start.sh
```

`start.sh` starts the **Python floor analyzer** (port 8787) when `python3` is available, then Vite on 5173.

Or run separately:

```bash
# Terminal 1 — structure analysis API (Mappedin-style 2D)
./python/start_analyzer.sh

# Terminal 2 — frontend
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The map loads fullscreen in **2D Mappedin-style** view.

## Mappedin-style 2D (Python + canvas)

Like Mappedin / Pointr, the app analyzes the 3D GLB and draws a clean architectural floor plan:

1. **Python** (`python/floor_analyzer/`) slices the mesh at floor height, cleans the grid with morphology, classifies corridors vs rooms, extracts walls and interior obstacles (pillars/furniture).
2. **Frontend** (`src/mappedinStyleView.ts`) renders white floors, extruded gray walls, and navigation paths.

If the Python service is offline, the app falls back to the browser-only slice renderer (`floor2dView.ts`).

API (proxied as `/api/floor/*`):

```bash
curl -F "file=@map.glb" "http://127.0.0.1:8787/analyze?sliceY=0.5"
```

## Supabase (metadigilabs)

Copy `.env.example` to `.env` and set:

- `VITE_SUPABASE_URL` — metadigilabs project URL
- `VITE_SUPABASE_ANON_KEY` — anon / publishable key
- `VITE_NAVME_POI_TYPE` — default `navme_logins.poi_type` (e.g. `IIPC`)

The app reads **project config** from `navme_logins` (`poi_type`, `map_code`, `client_id`, `client_secret`) and **Origin/Destination** POIs from `navme_pois` filtered by the same `poi_type`.

Columns `client_id` and `client_secret` were added to `navme_logins`. Set them in Supabase SQL, e.g.:

```sql
UPDATE navme_logins
SET client_id = 'your-multiset-client-id',
    client_secret = 'your-multiset-client-secret'
WHERE poi_type = 'IIPC';
```

If `client_id` / `client_secret` are empty, the app falls back to defaults in `src/config.ts`.

Use the **Project** dropdown in the toolbar to switch `poi_type` (reloads map + POIs).

## URL overrides

- `?poi_type=IIPC` — project category
- `?map=MAP_XXXXX` — map code (overrides DB)
- `?cid=` / `?cs=` — MultiSet client credentials (overrides DB when set in URL via `getCreds`)

## Dev proxy

Vite proxies:

- `/api/multiset/*` → Supabase `multiset-proxy` edge function
- `/api/floor/*` → local Python floor analyzer (`127.0.0.1:8787`)
- `/api/proxy-external-fetch` → GLB signed-URL CORS bypass

Production builds use `NAVME_MULTISET_PROXY_BASE` directly (see `src/config.ts`).

## Build

```bash
npm run build
npm run preview
```
