import {
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
  const [request, response, promptAsync] = useAuthRequest(
    { clientId: config.clientId, scopes: [...SCOPES, config.apiScope], redirectUri },
    discovery,
  );
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const token = useRef<TokenResponse | null>(null);
  const refreshing = useRef<Promise<TokenResponse> | null>(null);

  const save = useCallback(async (t: TokenResponse) => {
    token.current = t;
    if (t.refreshToken) await storage.set(REFRESH_KEY, t.refreshToken);
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
      if (!saved) return !cancelled && setStatus('signedOut');
      try {
        const t = await refresh(discovery, saved);
        if (cancelled) return;
        await save(t);
        setStatus('signedIn');
      } catch {
        if (!cancelled) await signOut();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [discovery, refresh, save, signOut]);

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
      })
      .catch((e: Error) => setError(e.message));
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
        const current = token.current;
        if (current && TokenResponse.isTokenFresh(current, 120)) return current.accessToken;
        const refreshToken = current?.refreshToken ?? (await storage.get(REFRESH_KEY));
        if (!discovery || !refreshToken) {
          await signOut();
          throw new Error('Signed out');
        }
        try {
          const t = await refresh(discovery, refreshToken);
          await save(t);
          return t.accessToken;
        } catch (e) {
          await signOut();
          throw e;
        }
      },
    }),
    [discovery, status, error, request, promptAsync, signOut, refresh, save],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
