import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const examplesDir = resolve(here, '../../examples');

const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.txt': 'text/plain', '.css': 'text/css',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

/** Dev playground: serve ../../examples/** raw (untransformed, like the backend does) at /examples/. */
function serveExamples(): Plugin {
  return {
    name: 'pixelforge-serve-examples',
    configureServer(server) {
      server.middlewares.use('/examples', (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
        if (url === '/index.json') {
          const names = existsSync(examplesDir)
            ? readdirSync(examplesDir).filter((n) => existsSync(resolve(examplesDir, n, 'game.json')))
            : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(names));
          return;
        }
        const file = resolve(examplesDir, '.' + url);
        if (!file.startsWith(examplesDir + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [serveExamples()],
  // Permissive CORS so the playground's files can be loaded from a sandboxed (opaque-origin) iframe.
  server: { port: 5174, cors: { origin: '*' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    minify: true,
    lib: {
      entry: resolve(here, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'engine.js',
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
