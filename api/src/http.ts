/** Framework-neutral request/response so the same router runs in Functions, the dev server and tests. */
export interface ApiRequest {
  method: string;
  /** Path after /api, e.g. "/trips/123". */
  path: string;
  query: URLSearchParams;
  header(name: string): string | null;
  json(): Promise<unknown>;
}

export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  /** Serialized as JSON when set. */
  json?: unknown;
  /** Raw body (CSV, PDF). */
  body?: string | Uint8Array;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

export const ok = (json: unknown, status = 200): ApiResponse => ({ status, json });
export const noContent = (): ApiResponse => ({ status: 204 });

export function errorResponse(err: unknown): ApiResponse {
  if (err instanceof HttpError) {
    return { status: err.status, json: { error: err.message, ...(err.details ? { fields: err.details } : {}) } };
  }
  console.error(err);
  return { status: 500, json: { error: 'Internal server error' } };
}

type Params = Record<string, string>;
export type RouteHandler<Ctx> = (ctx: Ctx, params: Params) => Promise<ApiResponse>;

interface Route<Ctx> {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler<Ctx>;
}

/** Tiny path router: "/trips/:id" style patterns. */
export class Router<Ctx> {
  private routes: Route<Ctx>[] = [];

  on(method: string, path: string, handler: RouteHandler<Ctx>): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/\/:([a-zA-Z]+)/g, (_, key: string) => {
          keys.push(key);
          return '/([^/]+)';
        }).replace(/\./g, '\\.') +
        '/?$',
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  match(method: string, path: string): { handler: RouteHandler<Ctx>; params: Params } | 'method' | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: route.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}
