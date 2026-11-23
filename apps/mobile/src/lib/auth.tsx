import {
  TokenError,
  exchangeCodeAsync,
  makeRedirectUri,
  refreshAsync,
  TokenResponse,
  useAuthRequest,
  useAutoDiscovery,
  type DiscoveryDocument,
} from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { config } from './config';
import { storage } from './storage';

// Closes the sign-in popup on web once Entra redirects back.
WebBrowser.maybeCompleteAuthSession();

const REFRESH_KEY = 'mileage.refreshToken';
const HINT_KEY = 'mileage.loginHint';

/** The signed-in username from an ID token, used as a login hint next time (skips the account picker). */
function usernameFromIdToken(idToken: string | undefined): string | null {
  try {
    const part = idToken?.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.preferred_username === 'string' ? json.preferred_username : null;
  } catch {
    return null;
  }
}

/** Only an explicit rejection from Entra means the saved session is dead; network blips don't. */
const sessionRejected = (e: unknown) =>
  e instanceof TokenError && ['invalid_grant', 'interaction_required', 'login_required'].includes(e.code);

function describeError(e: unknown): string {
  if (e instanceof TokenError) return `${e.code}: ${e.description ?? ''}`.slice(0, 300);
  return e instanceof Error ? e.message : String(e);
}
const SCOPES = ['openid', 'profile', 'offline_access'];

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthState {
  status: Status;
  error: string | null;
  canSignIn: boolean;
  signIn(): void;
  signOut(): Promise<void>;
  /** A fresh access token for the API, or null in dev mode. Throws when signed out. */
  getAccessToken(): Promise<string | null>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return config.authMode === 'dev' ? <DevAuth>{children}</DevAuth> : <EntraAuth>{children}</EntraAuth>;
}

function DevAuth({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(true);
  const value = useMemo<AuthState>(
    () => ({
      status: signedIn ? 'signedIn' : 'signedOut',
      error: null,
      canSignIn: true,
      signIn: () => setSignedIn(true),
      signOut: async () => setSignedIn(false),
      getAccessToken: async () => null,
    }),
    [signedIn],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function EntraAuth({ children }: { children: ReactNode }) {
  const discovery = useAutoDiscovery(`https://login.microsoftonline.com/${config.tenantId}/v2.0`);
  const redirectUri = makeRedirectUri({ scheme: 'mileagelog', path: 'auth' });
  const [loginHint, setLoginHint] = useState<string | null>(null);
  useEffect(() => {
    void storage.get(HINT_KEY).then(setLoginHint);
  }, []);
  const [request, response, promptAsync] = useAuthRequest(
    {
      clientId: config.clientId,
      scopes: [...SCOPES, config.apiScope],
      redirectUri,
      extraParams: loginHint ? { login_hint: loginHint } : undefined,
    },
    discovery,
  );
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const token = useRef<TokenResponse | null>(null);
  const refreshing = useRef<Promise<TokenResponse> | null>(null);
  // Screens can mount while the saved session is restored; their API calls wait for this.
  const restored = useRef(deferred());
  const discoveryRef = useRef(discovery);
  discoveryRef.current = discovery;

  const save = useCallback(async (t: TokenResponse) => {
    token.current = t;
    if (t.refreshToken) await storage.set(REFRESH_KEY, t.refreshToken);
    else console.warn('[auth] Entra returned no refresh token; the session will not survive a reload');
    const hint = usernameFromIdToken(t.idToken);
    if (hint) await storage.set(HINT_KEY, hint);
  }, []);

  /** Forget the session in this window; drop the saved token only when Entra rejected it. */
  const lose = useCallback(async (e: unknown) => {
    console.warn('[auth] could not refresh the session:', describeError(e));
    token.current = null;
    if (sessionRejected(e)) await storage.remove(REFRESH_KEY);
    setStatus('signedOut');
  }, []);

  const signOut = useCallback(async () => {
    token.current = null;
    await storage.remove(REFRESH_KEY);
    setStatus('signedOut');
  }, []);

  const refresh = useCallback(
    (doc: DiscoveryDocument, refreshToken: string) => {
      refreshing.current ??= refreshAsync(
        { clientId: config.clientId, refreshToken, scopes: [...SCOPES, config.apiScope] },
        doc,
      ).finally(() => {
        refreshing.current = null;
      });
      return refreshing.current;
    },
    [],
  );

  // Restore a session from the saved refresh token.
  useEffect(() => {
    if (!discovery) return;
    let cancelled = false;
    (async () => {
      const saved = await storage.get(REFRESH_KEY);
      if (!saved) {
        if (!cancelled) setStatus('signedOut');
        restored.current.resolve();
        return;
      }
      try {
        const t = await refresh(discovery, saved);
        if (cancelled) return;
        await save(t);
        setStatus('signedIn');
      } catch (e) {
        if (!cancelled) await lose(e);
      } finally {
        restored.current.resolve();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [discovery, refresh, save, lose]);

  // Finish an interactive sign-in.
  useEffect(() => {
    if (!response || !discovery || !request) return;
    if (response.type === 'error') {
      setError(response.params.error_description ?? response.error?.message ?? 'Sign-in failed');
      return;
    }
    if (response.type !== 'success') return;
    exchangeCodeAsync(
      {
        clientId: config.clientId,
        code: response.params.code,
        redirectUri,
        extraParams: { code_verifier: request.codeVerifier ?? '' },
      },
      discovery,
    )
      .then(async (t) => {
        await save(t);
        setError(null);
        setStatus('signedIn');
        restored.current.resolve();
      })
      .catch((e: unknown) => {
        console.warn('[auth] sign-in code exchange failed:', describeError(e));
        setError(describeError(e));
      });
  }, [response, discovery, request, redirectUri, save]);

  const value = useMemo<AuthState>(
    () => ({
      status: discovery ? status : 'loading',
      error,
      canSignIn: Boolean(request),
      signIn: () => {
        setError(null);
        void promptAsync();
      },
      signOut,
      async getAccessToken() {
        await restored.current.promise;
        const current = token.current;
        if (current && TokenResponse.isTokenFresh(current, 120)) return current.accessToken;
        const refreshToken = current?.refreshToken ?? (await storage.get(REFRESH_KEY));
        const doc = discoveryRef.current;
        if (!doc || !refreshToken) throw new Error('Signed out');
        try {
          const t = await refresh(doc, refreshToken);
          await save(t);
          return t.accessToken;
        } catch (e) {
          await lose(e);
          throw e;
        }
      },
    }),
    [discovery, status, error, request, promptAsync, signOut, refresh, save, lose],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
