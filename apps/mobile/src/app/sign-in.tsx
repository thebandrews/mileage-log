import { Text, View } from 'react-native';
import { Button, Loading, colors, styles } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { config, entraConfigured } from '@/lib/config';

export default function SignIn() {
  const { status, signIn, canSignIn, error } = useAuth();
  if (status === 'loading') return <Loading />;

  const misconfigured = config.authMode === 'entra' && !entraConfigured;
  return (
    <View style={[styles.center, { gap: 16 }]}>
      <Text style={{ fontSize: 32, fontWeight: '800', color: colors.primary }}>Mileage Log</Text>
      <Text style={[styles.muted, { textAlign: 'center', maxWidth: 320 }]}>
        Pacifica Landscapes trip log. Sign in with your work Microsoft account.
      </Text>
      {misconfigured ? (
        <Text style={[styles.error, { textAlign: 'center', maxWidth: 320 }]}>
          Sign-in isn't configured. Set EXPO_PUBLIC_ENTRA_TENANT_ID, EXPO_PUBLIC_ENTRA_CLIENT_ID and
          EXPO_PUBLIC_ENTRA_API_SCOPE.
        </Text>
      ) : (
        <View style={{ width: '100%', maxWidth: 320 }}>
          <Button title="Sign in with Microsoft" onPress={signIn} disabled={!canSignIn} />
        </View>
      )}
      {error ? <Text style={[styles.error, { textAlign: 'center', maxWidth: 320 }]}>{error}</Text> : null}
    </View>
  );
}
