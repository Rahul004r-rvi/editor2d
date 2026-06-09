-- Run on metadigilabs Supabase if columns are not applied yet.
ALTER TABLE public.navme_logins
  ADD COLUMN IF NOT EXISTS client_id text,
  ADD COLUMN IF NOT EXISTS client_secret text;

-- Example: set credentials for IIPC (replace with your MultiSet M2M values)
-- UPDATE public.navme_logins
-- SET client_id = 'your-client-id', client_secret = 'your-client-secret'
-- WHERE poi_type = 'IIPC';
