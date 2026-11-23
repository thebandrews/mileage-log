import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { createApp } from '../app.js';
import { createAuthenticator } from '../auth.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { servicesFromEnv } from '../services.js';

const api = createApp(createPool(), createAuthenticator(loadConfig()), servicesFromEnv());

/** One catch-all HTTP function; routing happens in app.ts. */
app.http('api', {
  route: '{*path}',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  handler: async (request: HttpRequest): Promise<HttpResponseInit> => {
    const url = new URL(request.url);
    const res = await api.handle({
      method: request.method,
      path: url.pathname.replace(/^\/api/, '') || '/',
      query: url.searchParams,
      header: (name) => request.headers.get(name),
      json: () => request.json(),
    });
    if (res.json !== undefined) {
      return { status: res.status, headers: res.headers, jsonBody: res.json };
    }
    return { status: res.status, headers: res.headers, body: res.body };
  },
});
