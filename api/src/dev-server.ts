/**
 * Local API server without Azure Functions Core Tools.
 *   DATABASE_URL=postgres://... AUTH_MODE=dev npm run dev:api
 * Listens on :7071 like `func start`, serving /api/*.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { createApp } from './app.js';
import { createAuthenticator } from './auth.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { servicesFromEnv } from './services.js';

const port = Number(process.env.PORT ?? 7071);
const api = createApp(createPool(), createAuthenticator(loadConfig()), servicesFromEnv());

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  // Permissive CORS for the Expo web dev server.
  res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-dev-user');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('access-control-expose-headers', 'content-disposition');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  if (!url.pathname.startsWith('/api/')) return void res.writeHead(404).end();

  const raw = await readBody(req);
  const out = await api.handle({
    method: req.method ?? 'GET',
    path: url.pathname.slice(4),
    query: url.searchParams,
    header: (name) => {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : (v ?? null);
    },
    json: async () => JSON.parse(raw),
  });
  const headers = { ...out.headers };
  let payload: string | Uint8Array | undefined = out.body;
  if (out.json !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(out.json);
  }
  res.writeHead(out.status, headers).end(payload);
}).listen(port, () => console.log(`API listening on http://localhost:${port}/api`));
