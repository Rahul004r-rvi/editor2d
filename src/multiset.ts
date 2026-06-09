import type { GtaConfig } from './config';
import {
  GLB_CACHE_NAME,
  MULTISET_PUBLIC_API,
  NAVME_MULTISET_PROXY_BASE,
  USE_LOAD_CACHE,
} from './config';

if (typeof Response !== 'undefined' && !(Response.prototype as { _gtaJsonPatched?: boolean })._gtaJsonPatched) {
  Response.prototype.json = function patchedJson(this: Response) {
    return this.text().then((raw) => {
      const t = (raw ?? '').trim();
      if (!t) {
        return Promise.reject(
          new SyntaxError(
            'Empty response body (not valid JSON). Use Vite dev with /api/multiset proxy or a real API base URL.',
          ),
        );
      }
      try {
        return JSON.parse(t) as unknown;
      } catch (e) {
        const preview = t.length > 160 ? `${t.slice(0, 160)}…` : t;
        const err = new SyntaxError(`Invalid JSON in response: ${preview}`);
        (err as Error & { cause?: unknown }).cause = e;
        return Promise.reject(err);
      }
    });
  };
  (Response.prototype as { _gtaJsonPatched?: boolean })._gtaJsonPatched = true;
}

export type MultiSetEndpoints = {
  tokenUrl: string;
  mapInfoBaseUrl: string;
  fileUrl: string;
  proxyBase?: string;
};

function getBundlerEnv(): { DEV?: boolean; VITE_MULTISET_API_URL?: string } {
  if (import.meta.env.DEV) return { DEV: true, VITE_MULTISET_API_URL: import.meta.env.VITE_MULTISET_API_URL };
  return {
    VITE_MULTISET_API_URL:
      typeof import.meta.env.VITE_MULTISET_API_URL === 'string'
        ? import.meta.env.VITE_MULTISET_API_URL
        : undefined,
  };
}

function tokenCacheKey(clientId: string): string {
  return 'navme_ms_tok_' + clientId;
}

function readCachedToken(clientId: string): string | null {
  if (!USE_LOAD_CACHE || typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(tokenCacheKey(clientId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string; exp?: number };
    if (parsed.token && typeof parsed.exp === 'number' && Date.now() < parsed.exp) return parsed.token;
  } catch {
    /* ignore */
  }
  return null;
}

function writeCachedToken(clientId: string, token: string, expiresOn?: string): void {
  if (!USE_LOAD_CACHE || typeof sessionStorage === 'undefined') return;
  try {
    let exp = Date.now() + 25 * 60 * 1000;
    if (expiresOn) {
      const t = new Date(expiresOn).getTime() - 60 * 1000;
      if (t > Date.now()) exp = t;
    }
    sessionStorage.setItem(tokenCacheKey(clientId), JSON.stringify({ token, exp }));
  } catch {
    /* ignore */
  }
}

async function readCachedGlb(mapCode: string): Promise<ArrayBuffer | null> {
  if (!USE_LOAD_CACHE || typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(GLB_CACHE_NAME);
    const res = await cache.match('glb:' + mapCode);
    if (res) return res.arrayBuffer();
  } catch {
    /* ignore */
  }
  return null;
}

async function writeCachedGlb(mapCode: string, buf: ArrayBuffer): Promise<void> {
  if (!USE_LOAD_CACHE || typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(GLB_CACHE_NAME);
    await cache.put('glb:' + mapCode, new Response(buf.slice(0)));
  } catch {
    /* ignore */
  }
}

function isSupabaseMultisetProxyBase(base: string): boolean {
  return base.includes('/functions/v1/multiset-proxy');
}

function multisetProxyUrl(base: string, path: string, query?: Record<string, string>): string {
  const u = new URL(base.split('?')[0]);
  u.searchParams.set('_path', path.startsWith('/') ? path : `/${path}`);
  if (query) {
    Object.keys(query).forEach((k) => u.searchParams.set(k, query[k]));
  }
  return u.toString();
}

export function resolveMultiSetApiBase(cfg: Partial<GtaConfig>): string {
  const explicit = cfg.multiSetApiBaseUrl;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return explicit.trim().replace(/\/$/, '');
  }
  const env = getBundlerEnv();
  if (env.DEV) return '';
  if (env.VITE_MULTISET_API_URL) return env.VITE_MULTISET_API_URL.replace(/\/$/, '');
  return NAVME_MULTISET_PROXY_BASE;
}

export function buildMultiSetEndpoints(cfg: Partial<GtaConfig>): MultiSetEndpoints {
  const base = resolveMultiSetApiBase(cfg);
  const p = (sub: string) => {
    const path = sub.startsWith('/') ? sub : `/${sub}`;
    return base === '' ? `/api/multiset${path}` : `${base}${path}`;
  };
  return isSupabaseMultisetProxyBase(base)
    ? {
        proxyBase: base.split('?')[0],
        tokenUrl: multisetProxyUrl(base, '/v1/m2m/token'),
        mapInfoBaseUrl: p('/v1/vps/map'),
        fileUrl: multisetProxyUrl(base, '/v1/file'),
      }
    : {
        tokenUrl: p('/v1/m2m/token'),
        mapInfoBaseUrl: p('/v1/vps/map'),
        fileUrl: p('/v1/file'),
      };
}

export function resolveGlbCorsProxyPostUrl(cfg: Partial<GtaConfig>, apiBase: string): string | undefined {
  if (typeof cfg.glbCorsProxyPostUrl === 'string' && cfg.glbCorsProxyPostUrl.trim() !== '') {
    return cfg.glbCorsProxyPostUrl.trim();
  }
  if (import.meta.env.DEV) {
    return '/api/proxy-external-fetch';
  }
  if (
    apiBase !== '' &&
    apiBase !== MULTISET_PUBLIC_API &&
    !apiBase.startsWith('/') &&
    apiBase.startsWith('https://')
  ) {
    if (isSupabaseMultisetProxyBase(apiBase)) {
      return multisetProxyUrl(apiBase, '/proxy-external-fetch');
    }
    return `${apiBase}/proxy-external-fetch`;
  }
  return undefined;
}

async function readJsonResponse(res: Response, options: { allowEmpty?: boolean } = {}): Promise<unknown> {
  const text = await res.text();
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    if (options.allowEmpty) return null;
    throw new Error(`Empty response body (HTTP ${res.status})`);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`Expected JSON (${res.status}): ${trimmed.slice(0, 160)}`);
  }
}

async function getM2MToken(clientId: string, clientSecret: string, tokenUrl: string): Promise<{ token: string }> {
  const basicCredentials = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicCredentials}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let hint = '';
    if (/cloudfront|cacheable request|403/i.test(body)) {
      hint = ' CloudFront blocks browser POST to api.multiset.ai — use the Supabase proxy or Vite /api/multiset.';
    }
    throw new Error(`Auth failed (${res.status}): ${(body || res.statusText).slice(0, 400)}${hint}`);
  }
  const data = (await readJsonResponse(res)) as { token?: string; access_token?: string; expiresOn?: string };
  const token = data.token || data.access_token;
  if (!token) throw new Error('Auth response did not contain a token');
  writeCachedToken(clientId, token, data.expiresOn);
  return { token };
}

export async function getM2MTokenCached(
  clientId: string,
  clientSecret: string,
  tokenUrl: string,
): Promise<{ token: string }> {
  const cached = readCachedToken(clientId);
  if (cached) return { token: cached };
  return getM2MToken(clientId, clientSecret, tokenUrl);
}

function findMeshKey(info: Record<string, unknown>): string | null {
  const g = (k: string) => info[k] as unknown;
  if (g('meshKey')) return String(g('meshKey'));
  if (g('meshFileKey')) return String(g('meshFileKey'));
  const mesh = g('mesh') as Record<string, unknown> | undefined;
  if (mesh?.key) return String(mesh.key);
  if (mesh?.fileKey) return String(mesh.fileKey);
  if (g('glbKey')) return String(g('glbKey'));
  if (g('fileKey')) return String(g('fileKey'));
  const data = g('data') as Record<string, unknown> | undefined;
  if (data?.meshKey) return String(data.meshKey);
  const map = g('map') as Record<string, unknown> | undefined;
  if (map?.meshKey) return String(map.meshKey);
  const ob = g('offlineBundle') as Record<string, unknown> | undefined;
  if (ob?.meshKey) return String(ob.meshKey);
  if (ob?.key) return String(ob.key);
  if (ob?.glbKey) return String(ob.glbKey);
  const filesObj = g('files');
  if (filesObj && typeof filesObj === 'object' && !Array.isArray(filesObj)) {
    for (const k of Object.keys(filesObj as object)) {
      if (/\.glb$/i.test(k) || /mesh|model|3d/i.test(k))
        return String((filesObj as Record<string, string>)[k]);
    }
  }
  if (Array.isArray(filesObj)) {
    type FileEntry = { key?: string; path?: string; name?: string; type?: string; url?: string };
    const glb = (filesObj as FileEntry[]).find((f) => {
      const path = (f.key || f.path || f.name || '').toLowerCase();
      return path.endsWith('.glb') || path.endsWith('.gltf') || (f.type || '').toLowerCase().includes('mesh');
    });
    if (glb) return glb.key || glb.path || glb.url || null;
  }
  return deepFindGlb(info);
}

function buildFallbackKey(info: Record<string, unknown>): string | null {
  const accountId =
    (info.accountId as string) ||
    (info.account_id as string) ||
    (info.userId as string) ||
    (info.user_id as string);
  const mapId =
    (info._id as string) || (info.id as string) || (info.mapId as string) || (info.map_id as string);
  if (accountId && mapId) return `${accountId}/${mapId}/Mesh/TexturedMesh.glb`;
  return null;
}

function deepFindGlb(obj: unknown, depth = 0): string | null {
  if (depth > 5 || !obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const val = rec[key];
    if (typeof val === 'string') {
      const lower = val.toLowerCase();
      if (lower.endsWith('.glb') || lower.endsWith('.gltf')) return val;
      if (lower.includes('/mesh/') && (lower.includes('.glb') || lower.includes('.gltf'))) return val;
    } else if (typeof val === 'object' && val !== null) {
      const found = deepFindGlb(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function fetchGlbArrayBuffer(downloadUrl: string, glbCorsProxyPostUrl?: string): Promise<ArrayBuffer> {
  try {
    const direct = await fetch(downloadUrl, { redirect: 'follow' });
    if (direct.ok) return direct.arrayBuffer();
  } catch {
    /* CORS */
  }
  const postUrl =
    typeof glbCorsProxyPostUrl === 'string' && glbCorsProxyPostUrl.trim() !== ''
      ? glbCorsProxyPostUrl.trim()
      : import.meta.env.DEV
        ? '/api/proxy-external-fetch'
        : undefined;
  if (!postUrl) {
    throw new Error(
      'GLB download blocked by CORS. Use npm run dev (local GLB proxy) or set glbCorsProxyPostUrl to a streaming proxy.',
    );
  }
  const proxyRes = await fetch(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: downloadUrl }),
  });
  if (!proxyRes.ok) {
    const hint = await proxyRes.text().catch(() => '');
    if (proxyRes.status === 546 || /WORKER_RESOURCE_LIMIT/i.test(hint)) {
      throw new Error(
        'GLB is too large for the cloud edge proxy (546). Restart with npm run dev so Vite streams the file locally, or use a smaller mesh.',
      );
    }
    throw new Error(`GLB download failed (${proxyRes.status}): ${hint.slice(0, 200)}`);
  }
  return proxyRes.arrayBuffer();
}

async function tryDownload(
  token: string,
  key: string,
  endpoints: MultiSetEndpoints,
  glbCorsProxyPostUrl?: string,
): Promise<ArrayBuffer | null> {
  const fileFetchUrl = endpoints.proxyBase
    ? multisetProxyUrl(endpoints.proxyBase, '/v1/file', { key })
    : `${endpoints.fileUrl}?key=${encodeURIComponent(key)}`;
  const fileRes = await fetch(fileFetchUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileRes.ok) return null;
  const fileData = (await readJsonResponse(fileRes)) as Record<string, string | undefined>;
  const downloadUrl =
    fileData.url || fileData.downloadUrl || fileData.signedUrl || fileData.presignedUrl;
  if (!downloadUrl) return null;
  return fetchGlbArrayBuffer(downloadUrl, glbCorsProxyPostUrl);
}

function orderMeshKeysForDownload(meshKey: string, preferSmaller = false): string[] {
  const key = String(meshKey || '');
  if (!key) return [];
  const textured = key.replace(/\/mesh\/mesh\.glb$/i, '/Mesh/TexturedMesh.glb');
  const plain = key.replace(/\/mesh\/texturedmesh\.glb$/i, '/Mesh/Mesh.glb');
  const isKnownMeshPath =
    /\/mesh\/texturedmesh\.glb$/i.test(key) || /\/mesh\/mesh\.glb$/i.test(key);
  if (!isKnownMeshPath) return [key];
  const out: string[] = [];
  const add = (k: string) => {
    if (k && out.indexOf(k) < 0) out.push(k);
  };
  if (preferSmaller) {
    add(plain);
    add(textured);
  } else {
    add(textured);
    add(plain);
  }
  add(key);
  return out;
}

export async function downloadMapMesh(
  token: string,
  mapCode: string,
  endpoints: MultiSetEndpoints,
  glbCorsProxyPostUrl?: string,
  options: { preferSmallerMesh?: boolean } = {},
): Promise<ArrayBuffer | null> {
  const preferSmaller = options.preferSmallerMesh === true;
  const cachedGlb = await readCachedGlb(mapCode);
  if (cachedGlb) return cachedGlb;

  const mapUrl = endpoints.proxyBase
    ? multisetProxyUrl(endpoints.proxyBase, `/v1/vps/map/${encodeURIComponent(mapCode)}`)
    : `${endpoints.mapInfoBaseUrl}/${encodeURIComponent(mapCode)}`;

  const mapInfoRes = await fetch(mapUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!mapInfoRes.ok) {
    const errText = await mapInfoRes.text().catch(() => '');
    throw new Error(`Map info failed (${mapInfoRes.status}): ${errText || mapInfoRes.statusText}`);
  }
  const mapInfo = (await readJsonResponse(mapInfoRes)) as Record<string, unknown>;
  const meshKey = findMeshKey(mapInfo);
  if (!meshKey) {
    const fallbackKey = buildFallbackKey(mapInfo);
    if (fallbackKey) {
      const result = await tryDownload(token, fallbackKey, endpoints, glbCorsProxyPostUrl);
      if (result) {
        void writeCachedGlb(mapCode, result);
        return result;
      }
    }
    return null;
  }
  for (const key of orderMeshKeysForDownload(meshKey, preferSmaller)) {
    const result = await tryDownload(token, key, endpoints, glbCorsProxyPostUrl);
    if (result) {
      void writeCachedGlb(mapCode, result);
      return result;
    }
  }
  return null;
}
