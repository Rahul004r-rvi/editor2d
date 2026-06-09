-- Browser app uses Supabase anon key (same as navme_logins / navme_pois).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_floor_edits TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_floor_edits TO authenticated;
GRANT ALL ON TABLE public.navme_floor_edits TO service_role;
