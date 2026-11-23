import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from './config.js';
import { HttpError, type ApiRequest } from './http.js';

export interface Identity {
  /** Stable Entra object ID (or the dev user name in dev mode). */
  oid: string;
  email: string | null;
  name: string | null;
}

/** Delegated scope the mobile app requests: api://<api client id>/access_as_user */
export const REQUIRED_SCOPE = 'access_as_user';

export type Authenticator = (req: ApiRequest) => Promise<Identity>;

export function createAuthenticator(config: Config, keys?: JWTVerifyGetKey): Authenticator {
  if (config.authMode === 'dev') return devAuthenticator;

  const tenant = config.tenantId!;
  const jwks = keys ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`));
  const issuers = [`https://login.microsoftonline.com/${tenant}/v2.0`, `https://sts.windows.net/${tenant}/`];
  const audiences = [config.apiClientId!, `api://${config.apiClientId}`];

  return async (req) => {
    const header = req.header('authorization');
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new HttpError(401, 'Sign in required');

    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: issuers, audience: audiences, clockTolerance: 60 }));
    } catch {
      throw new HttpError(401, 'Invalid or expired token');
    }
    const scopes = String(payload.scp ?? '').split(' ');
    if (!scopes.includes(REQUIRED_SCOPE)) throw new HttpError(403, 'Token is missing the access_as_user scope');
    if (payload.tid !== tenant) throw new HttpError(403, 'Token is from another tenant');
    const oid = typeof payload.oid === 'string' ? payload.oid : null;
    if (!oid) throw new HttpError(401, 'Token has no user id');

    const email = (payload.preferred_username ?? payload.email ?? payload.upn ?? null) as string | null;
    return { oid, email, name: (payload.name as string | undefined) ?? null };
  };
}

/** Local development only: the caller names a user in X-Dev-User. */
const devAuthenticator: Authenticator = async (req) => {
  const user = req.header('x-dev-user')?.trim();
  if (!user) throw new HttpError(401, 'Set the X-Dev-User header (AUTH_MODE=dev)');
  return { oid: `dev:${user}`, email: `${user}@example.test`, name: user };
};
