import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { Button, Card, Loading, Screen, colors } from '@/components/ui';
import { useApi } from '@/lib/api';

/** Tesla sends the browser back here after you approve access (the redirect URI registered with Tesla). */
export default function TeslaCallback() {
  const { code, state, error } = useLocalSearchParams<{ code?: string; state?: string; error?: string }>();
  const api = useApi();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    if (error || !code || !state) {
      setResult({ ok: false, message: error ? `Tesla declined: ${error}` : 'Tesla did not send a sign-in code.' });
      return;
    }
    api
      .teslaCallback(code, state)
      .then((r) => {
        const cars = r.vehicles.filter((v) => v.teslaVin).map((v) => v.name);
        setResult({ ok: true, message: `Connected. Linked: ${cars.join(', ') || 'no cars found on this account'}.` });
      })
      .catch((e: Error) => setResult({ ok: false, message: e.message }));
  }, [api, code, state, error]);

  if (!result) return <Loading />;
  return (
    <Screen>
      <Card style={{ gap: 12 }}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: result.ok ? colors.primary : colors.danger }}>
          {result.ok ? 'Tesla connected' : "Couldn't connect Tesla"}
        </Text>
        <Text style={{ color: colors.text }}>{result.message}</Text>
        <Button title="Done" onPress={() => router.replace('/settings')} />
      </Card>
    </Screen>
  );
}
