import { Redirect } from 'expo-router';
import { Loading } from '@/components/ui';
import { useAuth } from '@/lib/auth';

/** Redirect target for Entra sign-in (mileagelog://auth and https://<site>/auth). */
export default function AuthCallback() {
  const { status } = useAuth();
  if (status === 'signedIn') return <Redirect href="/" />;
  return <Loading />;
}
