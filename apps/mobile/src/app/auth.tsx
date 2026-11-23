import { Redirect, type Href } from 'expo-router';
import { useMemo } from 'react';
import { Loading } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { takeReturnPath } from '@/lib/returnPath';

/**
 * Redirect target for Entra sign-in (mileagelog://auth and https://<site>/auth).
 * The router can also land here when signed out, so send those visits to sign-in.
 */
export default function AuthCallback() {
  const { status } = useAuth();
  const target = useMemo(() => (status === 'signedIn' ? takeReturnPath() : null), [status]);
  if (target) return <Redirect href={target as Href} />;
  if (status === 'signedOut') return <Redirect href="/sign-in" />;
  return <Loading />;
}
