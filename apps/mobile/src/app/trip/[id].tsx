import {
  fieldErrors,
  localDate,
  localTime,
  tripInputSchema,
  type Classification,
  type Trip,
  type TripInput,
  type Vehicle,
} from '@mileage/shared';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, Text, View } from 'react-native';
import { Button, ErrorBanner, Field, Loading, Muted, Screen, Segmented, colors } from '@/components/ui';
import { ApiError, useApi } from '@/lib/api';
import { deviceTimezone, formatMiles, nowTime, toIso, today } from '@/lib/dates';

const CLASSES: { value: Classification; label: string; color: string }[] = [
  { value: 'business', label: 'Business', color: colors.business },
  { value: 'personal', label: 'Personal', color: colors.personal },
  { value: 'commute', label: 'Commute', color: colors.commute },
  { value: 'unclassified', label: 'Later', color: colors.unclassified },
];

type Mode = 'odometer' | 'miles';

interface Form {
  date: string;
  time: string;
  vehicleId: string | null;
  classification: Classification;
  mode: Mode;
  startOdometer: string;
  endOdometer: string;
  miles: string;
  startLabel: string;
  endLabel: string;
  purpose: string;
  client: string;
  notes: string;
}

function blankForm(): Form {
  return {
    date: today(),
    time: nowTime(),
    vehicleId: null,
    classification: 'business',
    mode: 'miles',
    startOdometer: '',
    endOdometer: '',
    miles: '',
    startLabel: '',
    endLabel: '',
    purpose: '',
    client: '',
    notes: '',
  };
}

function fromTrip(t: Trip): Form {
  const tz = deviceTimezone();
  const hasOdo = t.startOdometer !== null && t.endOdometer !== null;
  return {
    date: localDate(t.startedAt, tz),
    time: localTime(t.startedAt, tz),
    vehicleId: t.vehicleId,
    classification: t.classification,
    mode: hasOdo ? 'odometer' : 'miles',
    startOdometer: t.startOdometer?.toString() ?? '',
    endOdometer: t.endOdometer?.toString() ?? '',
    miles: t.miles.toString(),
    startLabel: t.startLabel ?? '',
    endLabel: t.endLabel ?? '',
    purpose: t.purpose ?? '',
    client: t.client ?? '',
    notes: t.notes ?? '',
  };
}

const numberOrNull = (s: string) => (s.trim() === '' ? null : Number(s.replace(/,/g, '')));

function toInput(f: Form, existing: Trip | null): TripInput {
  const odo = f.mode === 'odometer';
  return {
    vehicleId: f.vehicleId,
    startedAt: toIso(f.date, f.time) ?? 'invalid',
    // Keep the original end time unless the start moved; manual trips rarely know it.
    endedAt: existing?.endedAt ?? null,
    startOdometer: odo ? numberOrNull(f.startOdometer) : null,
    endOdometer: odo ? numberOrNull(f.endOdometer) : null,
    miles: odo ? null : numberOrNull(f.miles),
    classification: f.classification,
    startLabel: f.startLabel,
    endLabel: f.endLabel,
    purpose: f.purpose,
    client: f.client,
    notes: f.notes,
    source: existing?.source ?? 'manual',
  };
}

function confirm(title: string, message: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(globalThis.confirm?.(`${title}\n${message}`) ?? false);
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Delete', style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}

export default function TripEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const api = useApi();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [form, setForm] = useState<Form | null>(isNew ? blankForm() : null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [vs, t] = await Promise.all([api.vehicles(), isNew ? Promise.resolve(null) : api.trip(id)]);
        const active = vs.filter((v) => !v.archived || v.id === t?.vehicleId);
        setVehicles(active);
        if (t) {
          setTrip(t);
          setForm(fromTrip(t));
        } else {
          // Default to the only/first active vehicle.
          setForm((f) => (f && !f.vehicleId && active[0] ? { ...f, vehicleId: active[0].id } : f));
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [api, id, isNew]);

  if (loadError) return <Screen><ErrorBanner message={loadError} /></Screen>;
  if (!form) return <Loading />;

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });
  const odoMiles =
    form.mode === 'odometer' && numberOrNull(form.endOdometer) !== null && numberOrNull(form.startOdometer) !== null
      ? numberOrNull(form.endOdometer)! - numberOrNull(form.startOdometer)!
      : null;

  async function save() {
    const input = toInput(form!, trip);
    const parsed = tripInputSchema.safeParse(input);
    if (!parsed.success) {
      const errs = fieldErrors(parsed.error);
      if (errs.startedAt) errs.date = 'Use YYYY-MM-DD and HH:MM.';
      return setErrors(errs);
    }
    setBusy(true);
    try {
      if (isNew) await api.createTrip(input);
      else await api.updateTrip(id, input);
      router.back();
    } catch (e) {
      setErrors(e instanceof ApiError ? { ...e.fields, _: e.message } : { _: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!(await confirm('Delete trip?', 'This removes the trip from your log.'))) return;
    setBusy(true);
    try {
      await api.deleteTrip(id);
      router.back();
    } catch (e) {
      setErrors({ _: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  }

  const business = form.classification === 'business';

  return (
    <Screen>
      <Stack.Screen options={{ title: isNew ? 'New trip' : 'Edit trip' }} />
      {errors._ ? <ErrorBanner message={errors._} /> : null}

      <Segmented label="Type" options={CLASSES} value={form.classification} onChange={(v) => set('classification', v)} />

      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 3 }}>
          <Field label="Date" value={form.date} onChangeText={(v) => set('date', v)} placeholder="YYYY-MM-DD" error={errors.date} autoCapitalize="none" />
        </View>
        <View style={{ flex: 2 }}>
          <Field label="Start time" value={form.time} onChangeText={(v) => set('time', v)} placeholder="HH:MM" keyboardType="numbers-and-punctuation" />
        </View>
      </View>

      {vehicles.length > 0 ? (
        <Segmented
          label="Vehicle"
          options={vehicles.map((v) => ({ value: v.id, label: v.name }))}
          value={form.vehicleId}
          onChange={(v) => set('vehicleId', v === form.vehicleId ? null : v)}
          error={errors.vehicleId}
        />
      ) : (
        <Muted>Add vehicles in Settings to tag trips by vehicle.</Muted>
      )}

      <Segmented
        label="Distance"
        options={[
          { value: 'miles', label: 'Miles' },
          { value: 'odometer', label: 'Odometer' },
        ]}
        value={form.mode}
        onChange={(v: Mode) => set('mode', v)}
      />
      {form.mode === 'miles' ? (
        <Field label="Miles" value={form.miles} onChangeText={(v) => set('miles', v)} keyboardType="decimal-pad" placeholder="12.4" error={errors.miles} />
      ) : (
        <>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Field label="Start odometer" value={form.startOdometer} onChangeText={(v) => set('startOdometer', v)} keyboardType="decimal-pad" error={errors.startOdometer} />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="End odometer" value={form.endOdometer} onChangeText={(v) => set('endOdometer', v)} keyboardType="decimal-pad" error={errors.endOdometer ?? errors.miles} />
            </View>
          </View>
          {odoMiles !== null && odoMiles > 0 ? <Muted>{formatMiles(Math.round(odoMiles * 10) / 10)} miles</Muted> : null}
        </>
      )}

      <Field label="From" value={form.startLabel} onChangeText={(v) => set('startLabel', v)} placeholder="e.g. Yard" error={errors.startLabel} />
      <Field
        label={business ? 'Destination (required)' : 'Destination'}
        value={form.endLabel}
        onChangeText={(v) => set('endLabel', v)}
        placeholder="e.g. Smith residence, Ballard"
        error={errors.endLabel}
      />
      <Field
        label={business ? 'Business purpose (required)' : 'Purpose'}
        value={form.purpose}
        onChangeText={(v) => set('purpose', v)}
        placeholder="e.g. Site walk for spring install"
        error={errors.purpose}
      />
      <Field label="Client" value={form.client} onChangeText={(v) => set('client', v)} error={errors.client} />
      <Field label="Notes" value={form.notes} onChangeText={(v) => set('notes', v)} multiline error={errors.notes} />

      <Button title={isNew ? 'Save trip' : 'Save changes'} onPress={save} busy={busy} />
      {!isNew ? <Button title="Delete trip" kind="secondary" onPress={remove} disabled={busy} /> : null}
      {trip ? (
        <Text style={{ color: colors.muted, fontSize: 12, textAlign: 'center' }}>
          Source: {trip.source} · last updated {new Date(trip.updatedAt).toLocaleString()}
        </Text>
      ) : null}
    </Screen>
  );
}
