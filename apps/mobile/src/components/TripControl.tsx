import { localTime, type Trip, type Vehicle } from '@mileage/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Linking, Platform, Text, View } from 'react-native';
import { ApiError, useApi } from '@/lib/api';
import { deviceTimezone, formatMiles } from '@/lib/dates';
import { beginTrack, finishTrack, gpsProblem, gpsSupported, readTrack, resumeTrack, stopTrack, type Track } from '@/lib/gps';
import { currentPoint } from '@/lib/location';
import { storage } from '@/lib/storage';
import { Button, Card, Field, Muted, Segmented, colors } from './ui';

const LAST_VEHICLE = 'mileage.lastVehicle';

const readsFromCar = (v: Vehicle | undefined, teslaConnected: boolean) => Boolean(v?.teslaVin && teslaConnected);

const numberOrNull = (s: string) => (s.trim() === '' ? null : Number(s.replace(/,/g, '')));

function confirmCancel(): Promise<boolean> {
  const title = 'Cancel this trip?';
  const message = "It won't be saved to your log.";
  if (Platform.OS === 'web') return Promise.resolve(globalThis.confirm?.(`${title}\n${message}`) ?? false);
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Keep trip', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Cancel trip', style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}

/**
 * Start trip / End trip. Miles come from a linked Tesla; otherwise the iPhone app measures them
 * with GPS, and odometer readings are optional. The web app can't track in the background, so
 * there it's odometer readings.
 */
export function TripControl({
  active,
  vehicles,
  teslaConnected,
  onChanged,
}: {
  active: Trip | null;
  vehicles: Vehicle[];
  teslaConnected: boolean;
  onChanged: () => void;
}) {
  const api = useApi();
  const usable = vehicles.filter((v) => !v.archived);
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [odometer, setOdometer] = useState('');
  const [busy, setBusy] = useState<'start' | 'end' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  /** The last error came from location permissions: offer a way to Settings. */
  const [settingsHint, setSettingsHint] = useState(false);
  /** GPS distance for the active trip; null when this phone isn't measuring it. */
  const [track, setTrack] = useState<Track | null>(null);

  // Default to the vehicle used last time, else the only one.
  useEffect(() => {
    void storage.get(LAST_VEHICLE).then((saved) => {
      setVehicleId((current) => {
        if (current && usable.some((v) => v.id === current)) return current;
        if (saved && usable.some((v) => v.id === saved)) return saved;
        return usable.length === 1 ? usable[0].id : null;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicles]);

  const tripVehicle = active ? vehicles.find((v) => v.id === active.vehicleId) : undefined;
  const selected = usable.find((v) => v.id === vehicleId);
  const fromCar = readsFromCar(active ? tripVehicle : selected, teslaConnected);

  // The vehicle's last reading: pre-filled when the odometer is required, a hint when it's optional
  // (a stale reading nobody checked shouldn't land in the log).
  const [lastReading, setLastReading] = useState<number | null>(null);
  useEffect(() => {
    setOdometer('');
    setLastReading(null);
    setFieldError(undefined);
    if (active || !vehicleId || readsFromCar(selected, teslaConnected)) return;
    let cancelled = false;
    void api
      .lastOdometer(vehicleId)
      .then((r) => {
        if (cancelled || r.lastOdometer === null) return;
        if (gpsSupported) setLastReading(r.lastOdometer);
        else setOdometer(String(r.lastOdometer));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId, active?.id, teslaConnected]);

  // Pick the GPS track back up (iOS stops it if the app was swiped away) and show the miles so far.
  useEffect(() => {
    setTrack(null);
    if (!active || !gpsSupported || fromCar) return;
    let cancelled = false;
    const refresh = () =>
      void readTrack(active.id)
        .then((t) => !cancelled && setTrack(t))
        .catch(() => {});
    void resumeTrack(active.id).catch(() => {}).then(refresh);
    const timer = setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, fromCar]);

  function fail(e: unknown) {
    if (e instanceof ApiError) {
      const field = e.fields.startOdometer ?? e.fields.endOdometer ?? e.fields.miles;
      if (field) setFieldError(field);
      else setError(e.message);
    } else {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function start() {
    setError(null);
    setFieldError(undefined);
    setSettingsHint(false);
    const reading = numberOrNull(odometer);
    if (reading !== null && !(reading >= 0)) {
      setFieldError('Enter a valid odometer reading.');
      return;
    }
    // Without the car, miles come from GPS, an odometer reading, or both.
    const problem = fromCar ? null : await gpsProblem();
    const useGps = !fromCar && problem === null;
    if (!fromCar && !useGps && reading === null) {
      if (gpsSupported) {
        setError(problem);
        setSettingsHint(true);
      } else {
        setFieldError('Enter the odometer reading before you drive.');
      }
      return;
    }
    setBusy('start');
    try {
      if (vehicleId) await storage.set(LAST_VEHICLE, vehicleId);
      const location = await currentPoint();
      const trip = await api.startTrip({ vehicleId, location, startOdometer: fromCar ? null : reading });
      if (useGps) {
        try {
          await beginTrack(trip.id, location);
        } catch (e) {
          setError(
            `GPS couldn't start (${e instanceof Error ? e.message : String(e)}). ` +
              (reading === null ? 'Enter the miles when you arrive.' : 'Enter the odometer when you arrive.'),
          );
        }
      }
      setOdometer('');
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) onChanged();
      else fail(e);
    } finally {
      setBusy(null);
    }
  }

  async function end() {
    if (!active) return;
    setError(null);
    setFieldError(undefined);
    const reading = numberOrNull(odometer);
    const hasStart = active.startOdometer !== null;
    if (reading !== null && !(reading > 0)) {
      setFieldError(hasStart ? 'Enter a valid odometer reading.' : 'Enter the miles for this trip.');
      return;
    }
    if (!fromCar && !track && reading === null) {
      setFieldError(hasStart ? 'Enter the odometer reading now that you have arrived.' : 'Enter the miles for this trip.');
      return;
    }
    setBusy('end');
    try {
      const location = await currentPoint();
      const measured = !fromCar && track ? await finishTrack(active.id, location) : null;
      const gpsMiles = measured && measured.miles > 0 ? measured.miles : null;
      if (!fromCar && gpsMiles === null && reading === null) {
        setFieldError(
          hasStart
            ? 'GPS didn’t pick up this trip. Enter the end odometer.'
            : 'GPS didn’t pick up this trip. Enter the miles.',
        );
        return;
      }
      const trip = await api.endTrip(active.id, {
        location,
        endOdometer: fromCar || !hasStart ? null : reading,
        miles: fromCar || hasStart ? null : reading,
        gpsMiles,
      });
      await stopTrack();
      setOdometer('');
      onChanged();
      router.push({
        pathname: '/trip/[id]',
        params: { id: trip.id, classify: '1', ...(trip.source === 'gps' && measured?.needsCheck ? { gpsCheck: '1' } : {}) },
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!active || !(await confirmCancel())) return;
    setError(null);
    setBusy('cancel');
    try {
      await api.deleteTrip(active.id);
      await stopTrack();
      setOdometer('');
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  if (active) {
    const tz = deviceTimezone();
    return (
      <Card style={{ gap: 12, borderColor: colors.primary, borderWidth: 1.5 }}>
        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.primary, textTransform: 'uppercase' }}>
            Trip in progress
          </Text>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
            Since {localTime(active.startedAt, tz)}
            {active.startLabel ? ` from ${active.startLabel}` : ''}
          </Text>
          <Muted>
            {[tripVehicle?.name, active.startOdometer !== null && `odometer ${formatMiles(active.startOdometer)}`]
              .filter(Boolean)
              .join(' · ')}
          </Muted>
        </View>
        {fromCar ? (
          <Muted>The car reports the miles when you end the trip.</Muted>
        ) : (
          <>
            {track ? (
              <View style={{ gap: 2 }}>
                <Text style={{ fontSize: 28, fontWeight: '800', color: colors.text }}>{formatMiles(track.miles)} mi</Text>
                <Muted>
                  {track.running ? 'so far, measured by GPS' : 'measured by GPS before tracking stopped'}
                  {track.needsCheck ? ' · lost signal for a stretch, check the miles at the end' : ''}
                </Muted>
              </View>
            ) : null}
            {active.startOdometer !== null ? (
              <Field
                label={track ? 'End odometer (optional)' : 'End odometer'}
                value={odometer}
                onChangeText={setOdometer}
                keyboardType="decimal-pad"
                placeholder={`More than ${active.startOdometer}`}
                error={fieldError}
              />
            ) : !track ? (
              <Field
                label="Miles driven"
                value={odometer}
                onChangeText={setOdometer}
                keyboardType="decimal-pad"
                placeholder="e.g. 12.4"
                error={fieldError}
              />
            ) : fieldError ? (
              <Text style={{ color: colors.danger }}>{fieldError}</Text>
            ) : null}
          </>
        )}
        {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
        <Button
          title={fromCar ? 'End trip · read the car' : 'End trip'}
          onPress={end}
          busy={busy === 'end'}
          disabled={busy === 'cancel'}
        />
        <Button title="Cancel trip" kind="secondary" onPress={cancel} busy={busy === 'cancel'} disabled={busy === 'end'} />
      </Card>
    );
  }

  return (
    <Card style={{ gap: 12 }}>
      {usable.length > 0 ? (
        <Segmented
          label="Vehicle"
          options={usable.map((v) => ({ value: v.id, label: v.teslaVin && teslaConnected ? `${v.name} ⚡` : v.name }))}
          value={vehicleId}
          onChange={(v) => setVehicleId(v)}
        />
      ) : (
        <Muted>Add your vehicles in Settings so trips are tagged and odometer readings carry over.</Muted>
      )}
      {fromCar ? (
        <Muted>Miles come from the car: tap Start when you set off and End when you arrive.</Muted>
      ) : (
        <>
          {gpsSupported ? (
            <Muted>Your phone measures the miles with GPS, even when it's locked. Add the odometer if you like.</Muted>
          ) : null}
          <Field
            label={gpsSupported ? 'Start odometer (optional)' : 'Start odometer'}
            value={odometer}
            onChangeText={setOdometer}
            keyboardType="decimal-pad"
            placeholder={lastReading !== null ? `Last trip ended at ${lastReading}` : 'e.g. 15020.4'}
            error={fieldError}
          />
        </>
      )}
      {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
      {settingsHint && Platform.OS !== 'web' ? (
        <Button title="Open Settings" kind="secondary" onPress={() => void Linking.openURL('app-settings:')} />
      ) : null}
      <Button title="Start trip" onPress={start} busy={busy === 'start'} />
    </Card>
  );
}
