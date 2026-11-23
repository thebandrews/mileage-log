import { localTime, type Trip, type Vehicle } from '@mileage/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, Text, View } from 'react-native';
import { ApiError, useApi } from '@/lib/api';
import { deviceTimezone, formatMiles } from '@/lib/dates';
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

/** Start trip / End trip. Miles come from a linked Tesla, otherwise from odometer readings. */
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

  // Pre-fill the start odometer from the vehicle's last reading.
  useEffect(() => {
    setOdometer('');
    setFieldError(undefined);
    if (active || !vehicleId || readsFromCar(selected, teslaConnected)) return;
    let cancelled = false;
    void api
      .lastOdometer(vehicleId)
      .then((r) => !cancelled && r.lastOdometer !== null && setOdometer(String(r.lastOdometer)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId, active?.id, teslaConnected]);

  function fail(e: unknown) {
    if (e instanceof ApiError) {
      const field = e.fields.startOdometer ?? e.fields.endOdometer;
      if (field) setFieldError(field);
      else setError(e.message);
    } else {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function start() {
    setError(null);
    setFieldError(undefined);
    const reading = numberOrNull(odometer);
    if (!fromCar && (reading === null || !(reading >= 0))) {
      setFieldError('Enter the odometer reading before you drive.');
      return;
    }
    setBusy('start');
    try {
      if (vehicleId) await storage.set(LAST_VEHICLE, vehicleId);
      await api.startTrip({ vehicleId, location: await currentPoint(), startOdometer: fromCar ? null : reading });
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
    if (!fromCar && reading === null) {
      setFieldError('Enter the odometer reading now that you have arrived.');
      return;
    }
    setBusy('end');
    try {
      const trip = await api.endTrip(active.id, { location: await currentPoint(), endOdometer: fromCar ? null : reading });
      setOdometer('');
      onChanged();
      router.push({ pathname: '/trip/[id]', params: { id: trip.id, classify: '1' } });
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
          <Field
            label="End odometer"
            value={odometer}
            onChangeText={setOdometer}
            keyboardType="decimal-pad"
            placeholder={active.startOdometer !== null ? `More than ${active.startOdometer}` : undefined}
            error={fieldError}
          />
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
        <Field
          label="Start odometer"
          value={odometer}
          onChangeText={setOdometer}
          keyboardType="decimal-pad"
          placeholder="e.g. 15020.4"
          error={fieldError}
        />
      )}
      {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
      <Button title="Start trip" onPress={start} busy={busy === 'start'} />
    </Card>
  );
}
