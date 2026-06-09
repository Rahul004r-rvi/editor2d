-- Per-project 2D floor editor state (walk grid, zones, slice height) — separate from navme_logins.
CREATE TABLE IF NOT EXISTS public.navme_floor_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poi_type text NOT NULL,
  map_code text NOT NULL,
  floor_slice_y double precision NOT NULL DEFAULT -1.6,
  floor_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navme_floor_edits_poi_type_map_code_key UNIQUE (poi_type, map_code)
);

CREATE INDEX IF NOT EXISTS navme_floor_edits_poi_type_idx ON public.navme_floor_edits (poi_type);

COMMENT ON TABLE public.navme_floor_edits IS 'NavMe 2D floor editor snapshots: walk grid, named zones, floor slice Y per project/map.';
COMMENT ON COLUMN public.navme_floor_edits.floor_data IS 'JSON: walkGrid, zones (with labels), grid bounds, version.';
