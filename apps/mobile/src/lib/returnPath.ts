import { Platform } from 'react-native';

/**
 * The page the browser opened on (path + query), captured before routing runs. While the
 * Microsoft session is restored the router can pass through /auth; afterwards we send the
 * user back here — e.g. a bookmarked /reports or Tesla's /tesla/callback?code=…&state=….
 */
const initial =
  Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.pathname + window.location.search : null;
let used = false;

const NOT_A_DESTINATION = new Set(['/', '/auth', '/sign-in']);

/** Where to go once signed in: the original page the first time, home after that. */
export function takeReturnPath(): string {
  if (used || !initial) return '/';
  used = true;
  return NOT_A_DESTINATION.has(initial.split('?')[0]) ? '/' : initial;
}
