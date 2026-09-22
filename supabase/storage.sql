-- Supabase Storage setup for the Nepal Shop marketplace.
--
-- What this does:
--   1. Creates the four public-read buckets used for user-uploaded media:
--        product-images  — seller product photos      (POST /api/uploads)
--        banners         — homepage banner ads        (POST /api/banner-uploads)
--        avatars         — buyer profile photos       (POST /api/profile-uploads)
--        site-assets     — seller store logo/banner + site logo
--                                                 (POST /api/store-uploads, /api/site-logo-uploads)
--   2. Creates a single public-read policy on storage.objects covering all four.
--
-- RLS note: all inserts and deletes are performed server-side with the
-- SUPABASE_SERVICE_ROLE_KEY, which bypasses Row Level Security entirely,
-- so NO write (INSERT/UPDATE/DELETE) policies are needed here. Only public
-- SELECT is opened, so product photos, banners, avatars and logos can be
-- rendered directly from their public URLs without signed URLs.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- It is idempotent (safe to re-run).

-- 1. Buckets (public read).
INSERT INTO storage.buckets (id, name, public) VALUES
  ('product-images', 'product-images', true),
  ('banners',        'banners',        true),
  ('avatars',        'avatars',        true),
  ('site-assets',    'site-assets',    true)
ON CONFLICT (id) DO NOTHING;

-- 2. Public read policy. (Policy names must be unique per table; DROP first so
-- re-runs are idempotent, then create the single policy covering all buckets.)
DROP POLICY IF EXISTS "public read" ON storage.objects;
CREATE POLICY "public read" ON storage.objects FOR SELECT USING (bucket_id IN ('product-images','banners','avatars','site-assets'));
