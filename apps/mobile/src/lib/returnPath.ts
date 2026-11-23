import { Platform } from 'react-native';

/**
 * The page the browser opened on (path + query), captured before routing runs. While the
 * Microsoft session is restored the router can pass through /auth; afterwards we send the
 * user back here — e.g. a bookmarked /reports or Tesla's /tesla/callback?code=…&state=….
 */
let initial: string | null =
  Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.pathname + window.location.search : null;
let used = false;

/** The query string the page opened with (Entra's ?code=…&state=… after a sign-in redirect). */
export const initialQuery =
  Platform.OS === 'web' && typeof window !== 'undefined' && window.location.pathname === '/auth'
    ? new URLSearchParams(window.location.search)
    : null;

/** The page to come back to, without using it up. */
export function peekReturnPath(): string | null {
  return used ? null : initial;
}

/** Comes back from a sign-in redirect: go to the page the user was on before it. */
export function restoreReturnPath(path: string | null) {
  initial = path;
  used = false;
}

const NOT_A_DESTINATION = new Set(['/', '/auth', '/sign-in']);

/** Where to go once signed in: the original page the first time, home after that. */
export function takeReturnPath(): string {
  if (used || !initial) return '/';
  used = true;
  return NOT_A_DESTINATION.has(initial.split('?')[0]) ? '/' : initial;
}
