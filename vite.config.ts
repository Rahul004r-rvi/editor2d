import { defineConfig } from 'vite';
import { glbStreamProxyPlugin } from './vite-glb-proxy';

const MULTISET_PROXY =
  'https://vfpgtifzqznfdtecmpsc.supabase.co/functions/v1/multiset-proxy';

export default defineConfig({
  plugins: [glbStreamProxyPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api/multiset': {
        target: MULTISET_PROXY,
        changeOrigin: true,
        rewrite: (path) => {
          const sub = path.replace(/^\/api\/multiset/, '') || '/';
          return `/?_path=${encodeURIComponent(sub.startsWith('/') ? sub : `/${sub}`)}`;
        },
      },
      '/api/floor': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/floor/, ''),
      },
    },
  },
});
