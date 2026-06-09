import type { Connect, Plugin } from 'vite';

/** Streams large GLB downloads in dev — avoids Supabase edge WORKER_RESOURCE_LIMIT (546). */
export function glbStreamProxyPlugin(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url !== '/api/proxy-external-fetch' || req.method !== 'POST') {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      void (async () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const body = JSON.parse(raw) as { url?: string };
          const url = typeof body.url === 'string' ? body.url.trim() : '';
          if (!url) {
            res.statusCode = 400;
            res.end('Missing url');
            return;
          }
          const upstream = await fetch(url);
          if (!upstream.ok) {
            res.statusCode = upstream.status;
            res.end(await upstream.text().catch(() => upstream.statusText));
            return;
          }
          const ct = upstream.headers.get('content-type');
          if (ct) res.setHeader('content-type', ct);
          res.statusCode = 200;
          const buf = Buffer.from(await upstream.arrayBuffer());
          res.end(buf);
        } catch (err) {
          res.statusCode = 502;
          res.end(err instanceof Error ? err.message : String(err));
        }
      })();
    });
  };

  return {
    name: 'glb-stream-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
