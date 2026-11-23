import { Redirect } from 'expo-router';
import { Loading } from '@/components/ui';
import { useAuth } from '@/lib/auth';

/**
 * Redirect target for Entra sign-in (mileagelog://auth and https://<site>/auth).
 * The router can also land here when signed out, so send those visits to sign-in.
 */
export default function AuthCallback() {
  const { status } = useAuth();
  if (status === 'signedIn') return <Redirect href="/" />;
  if (status === 'signedOut') return <Redirect href="/sign-in" />;
  return <Loading />;
}
