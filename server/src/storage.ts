// Supabase Storage layer for user-uploaded media.
//
// Replaces local-disk uploads (UPLOADS_DIR + Bun.write) with Supabase
// Storage buckets. All uploaded files are public-read; writes always use
// the service_role key, which bypasses RLS, so no write policies exist on
// storage.objects (see supabase/storage.sql).
//
// Bucket map (all public read):
//   product photos      -> "product-images"
//   homepage banner ads -> "banners"
//   buyer profile avatars -> "avatars"
//   seller store logo/banner + site logo -> "site-assets"
//
// Security notes:
// - The service_role key is read ONLY from process.env.SUPABASE_SERVICE_ROLE_KEY.
//   It is never stored in the repo, never logged, and never returned.
// - The client is created lazily: getStorageClient() throws if an env var is
//   missing, but nothing fails at import time, so modules that only serve
//   legacy local files keep working without credentials.
// - The optional `client` parameter on uploadToBucket/deleteFromBucket is a
//   test seam: endpoint wiring can be tested against a stub SupabaseClient
//   without real credentials. It does NOT weaken auth or validation — those
//   live in the endpoint handlers, which are unchanged by this module.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Upload kind -> public-read bucket, mirroring the old /uploads/ layout. */
export const STORAGE_BUCKETS = {
  product: "product-images",
  banner: "banners",
  avatar: "avatars",
  store: "site-assets",
  sitelogo: "site-assets",
} as const;

export type StorageKind = keyof typeof STORAGE_BUCKETS;

/** Prefix inside absolute public URLs: <SUPABASE_URL>/storage/v1/object/public/<bucket>/<path> */
export const STORAGE_PUBLIC_URL_PREFIX = "/storage/v1/object/public/";

let cachedClient: SupabaseClient | null = null;

/**
 * Lazily create (and cache) the service-role Supabase client.
 * Throws a clear Error naming the missing env var — fail fast, but only
 * when storage is actually used, never at import time.
 */
export function getStorageClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error("Supabase storage is not configured: SUPABASE_URL is missing from the environment.");
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("Supabase storage is not configured: SUPABASE_SERVICE_ROLE_KEY is missing from the environment.");
  }
  if (!cachedClient) {
    cachedClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cachedClient;
}

/**
 * Path convention inside each bucket — preserves the existing filename
 * style from the local-disk endpoints (see UPLOAD_NAME_RE in selfhost.ts):
 *   product:  <uuid>.jpg        (no prefix)
 *   banner:   banner-<uuid>.<ext>
 *   avatar:   avatar-<uuid>.<ext>
 *   store:    store-<uuid>.<ext>
 *   sitelogo: sitelogo-<uuid>.<ext>
 *
 * `ext` must include the leading dot (e.g. ".jpg") and come from the
 * endpoint's validated UPLOAD_MIME_TO_EXT map — never from the client-supplied
 * filename. Pass `uuid` only in tests; production callers use a fresh one.
 */
export function bucketPathFor(kind: StorageKind, ext: string, uuid?: string): string {
  const id = uuid ?? crypto.randomUUID();
  switch (kind) {
    case "product":
      return `${id}${ext}`;
    case "banner":
      return `banner-${id}${ext}`;
    case "avatar":
      return `avatar-${id}${ext}`;
    case "store":
      return `store-${id}${ext}`;
    case "sitelogo":
      return `sitelogo-${id}${ext}`;
  }
}

/**
 * Upload bytes to a bucket and return the PUBLIC URL.
 * - upsert: false — storage paths are UUID-unique, so an existing-object
 *   conflict would indicate something badly wrong; never silently overwrite.
 * - Throws an Error carrying the storage error message on any failure
 *   (never swallows). Callers map this into their existing 400 responses.
 */
export async function uploadToBucket(
  bucket: string,
  path: string,
  data: Uint8Array | ArrayBuffer,
  contentType: string,
  client?: SupabaseClient,
): Promise<string> {
  const supabase = client ?? getStorageClient();
  const { error } = await supabase.storage.from(bucket).upload(path, data, {
    contentType,
    upsert: false,
    cacheControl: "31536000",
  });
  if (error) {
    throw new Error(`Supabase storage upload failed (${bucket}/${path}): ${error.message}`);
  }
  const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
  if (!pub?.publicUrl) {
    throw new Error(`Supabase storage upload succeeded but getPublicUrl returned no URL (${bucket}/${path}).`);
  }
  return pub.publicUrl;
}

/** Delete an object from a bucket. Throws on storage errors (never swallows). */
export async function deleteFromBucket(
  bucket: string,
  path: string,
  client?: SupabaseClient,
): Promise<void> {
  const supabase = client ?? getStorageClient();
  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) {
    throw new Error(`Supabase storage delete failed (${bucket}/${path}): ${error.message}`);
  }
}

export type StoredUploadRef =
  | { kind: "supabase"; bucket: string; path: string }
  | { kind: "legacy"; filename: string };
/**
 * Parse a stored upload URL so DELETE endpoints know what to remove:
 * - Absolute Supabase public URLs ("https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>")
 *   -> { kind: "supabase", bucket, path } for deleteFromBucket.
 * - Legacy "/uploads/<name>" rows (local-disk era) -> { kind: "legacy", filename }
 *   so the old local unlink can be attempted best-effort.
 */
export function parseStoredUploadUrl(storedUrl: string): StoredUploadRef {
  try {
    const u = new URL(storedUrl);
    const idx = u.pathname.indexOf(STORAGE_PUBLIC_URL_PREFIX);
    if (idx >= 0) {
      const rest = u.pathname.slice(idx + STORAGE_PUBLIC_URL_PREFIX.length);
      const slash = rest.indexOf("/");
      if (slash > 0) {
        return {
          kind: "supabase",
          bucket: rest.slice(0, slash),
          path: decodeURIComponent(rest.slice(slash + 1)),
        };
      }
    }
  } catch {
    // Not an absolute URL — fall through to legacy handling.
  }
  const filename = storedUrl.split("/").pop() ?? "";
  return { kind: "legacy", filename };
}

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const IMG_EXT_RE = "(jpg|png|webp|gif)";

/**
 * Filename shapes the upload endpoints actually produce (mirrors
 * bucketPathFor above). Used to validate stored URLs and to gate deletes:
 * we only ever delete objects whose names match what we created.
 */
export const UPLOAD_FILENAME_PATTERNS: Record<StorageKind, RegExp> = {
  product: new RegExp(`^${UUID_RE}\\.${IMG_EXT_RE}$`),
  banner: new RegExp(`^banner-${UUID_RE}\\.${IMG_EXT_RE}$`),
  avatar: new RegExp(`^avatar-${UUID_RE}\\.${IMG_EXT_RE}$`),
  store: new RegExp(`^store-${UUID_RE}\\.${IMG_EXT_RE}$`),
  sitelogo: new RegExp(`^sitelogo-${UUID_RE}\\.${IMG_EXT_RE}$`),
};

/**
 * Validate a stored upload URL for a zod field or inline check, WITHOUT
 * weakening the "only our uploader's output is accepted" rule:
 * - Legacy "/uploads/<filename>" rows from the local-disk era (filename
 *   must match the endpoint's pattern), OR
 * - An absolute Supabase public URL on the CONFIGURED project host:
 *   https://<SUPABASE_URL host>/storage/v1/object/public/<bucket>/<filename>
 *   where <bucket> is the expected bucket for `kind` and <filename> matches
 *   the endpoint's filename pattern. Any other host, bucket, path shape,
 *   or non-https scheme is rejected. Arbitrary external URLs are never
 *   accepted.
 */
export function isExpectedUploadUrl(storedUrl: string, kind: StorageKind): boolean {
  const bucket = STORAGE_BUCKETS[kind];
  const filenameRe = UPLOAD_FILENAME_PATTERNS[kind];
  // Legacy local-disk path.
  const legacy = storedUrl.match(/^\/uploads\/(.+)$/);
  if (legacy?.[1]) return filenameRe.test(legacy[1]);
  // Supabase public URL on the configured project.
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return false;
  let expectedHost: string;
  let u: URL;
  try {
    expectedHost = new URL(supabaseUrl).hostname;
    u = new URL(storedUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.hostname !== expectedHost) return false;
  const prefix = `${STORAGE_PUBLIC_URL_PREFIX}${bucket}/`;
  if (!u.pathname.startsWith(prefix)) return false;
  const filename = decodeURIComponent(u.pathname.slice(prefix.length));
  if (!filename || filename.includes("/")) return false; // no subdirectories
  return filenameRe.test(filename);
}
