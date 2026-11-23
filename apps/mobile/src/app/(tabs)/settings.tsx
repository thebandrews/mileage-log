import { irsBusinessRateCents, type Vehicle, type VehicleKind } from '@mileage/shared';
import { useState } from 'react';
import { Linking, Platform, Pressable, Switch, Text, View } from 'react-native';
import { Button, Card, ErrorBanner, Field, Loading, Muted, Screen, Segmented, colors } from '@/components/ui';
import { ApiError, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { today } from '@/lib/dates';
import { useLoad } from '@/lib/useLoad';

const KINDS: { value: VehicleKind; label: string }[] = [
  { value: 'car', label: 'Car' },
  { value: 'truck', label: 'Truck' },
  { value: 'van', label: 'Van' },
  { value: 'other', label: 'Other' },
];

function Toggle({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.text, fontSize: 15 }}>{label}</Text>
        {hint ? <Muted>{hint}</Muted> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.primary }} />
    </View>
  );
}

function VehicleForm({ onSaved }: { onSaved: () => void }) {
  const api = useApi();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<VehicleKind>('car');
  const [isTesla, setIsTesla] = useState(false);
  const [qnuv, setQnuv] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.createVehicle({ name, kind, isTesla, qualifiedNonpersonalUse: qnuv });
      setName('');
      setIsTesla(false);
      setQnuv(false);
      setError(undefined);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? (e.fields.name ?? e.message) : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 12, marginTop: 8 }}>
      <Field label="New vehicle" placeholder="e.g. Model Y" value={name} onChangeText={setName} error={error} />
      <Segmented options={KINDS} value={kind} onChange={setKind} />
      <Toggle label="Tesla" value={isTesla} onChange={setIsTesla} />
      <Toggle
        label="Marked, modified work vehicle"
        hint="Qualified nonpersonal use — no per-trip log needed"
        value={qnuv}
        onChange={setQnuv}
      />
      <Button title="Add vehicle" kind="secondary" onPress={save} busy={busy} disabled={!name.trim()} />
    </View>
  );
}

function VehicleRow({ vehicle, onChanged }: { vehicle: Vehicle; onChanged: () => void }) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(vehicle.name);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function update(changes: Partial<Pick<Vehicle, 'name' | 'archived'>>) {
    const { id: _id, createdAt: _c, teslaVin: _v, ...rest } = vehicle;
    await api.updateVehicle(vehicle.id, { ...rest, ...changes });
    onChanged();
  }

  async function saveName() {
    if (!name.trim()) return setError('Enter a name.');
    setBusy(true);
    try {
      await update({ name: name.trim() });
      setEditing(false);
      setError(undefined);
    } catch (e) {
      setError(e instanceof ApiError ? (e.fields.name ?? e.message) : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <View style={{ paddingVertical: 8, gap: 8 }}>
        <Field label="Vehicle name" value={name} onChangeText={setName} error={error} autoFocus onSubmitEditing={saveName} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Button title="Save name" onPress={saveName} busy={busy} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title="Cancel"
              kind="secondary"
              onPress={() => {
                setEditing(false);
                setName(vehicle.name);
                setError(undefined);
              }}
            />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 16 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: vehicle.archived ? colors.muted : colors.text, fontSize: 16 }}>{vehicle.name}</Text>
        <Muted>
          {[
            vehicle.kind,
            vehicle.teslaVin ? 'Tesla linked' : vehicle.isTesla && 'Tesla',
            vehicle.qualifiedNonpersonalUse && 'QNUV',
            vehicle.archived && 'archived',
          ]
            .filter(Boolean)
            .join(' · ')}
        </Muted>
      </View>
      <Pressable accessibilityRole="button" onPress={() => setEditing(true)} hitSlop={8}>
        <Text style={{ color: colors.primary }}>Rename</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => void update({ archived: !vehicle.archived })} hitSlop={8}>
        <Text style={{ color: colors.primary }}>{vehicle.archived ? 'Restore' : 'Archive'}</Text>
      </Pressable>
    </View>
  );
}

export default function Settings() {
  const api = useApi();
  const { signOut } = useAuth();
  const { data, error, loading, reload } = useLoad(
    () =>
      Promise.all([
        api.me(),
        api.vehicles(),
        api.teslaStatus().catch(() => ({ configured: false, connected: false })),
      ]),
    [api],
  );
  const [teslaError, setTeslaError] = useState<string | null>(null);
  const [rate, setRate] = useState<string | null>(null);
  const [rateError, setRateError] = useState<string | undefined>();

  if (!data && loading) return <Loading />;
  const [me, vehicles, tesla] = data ?? [null, [], { configured: false, connected: false }];

  async function connectTesla() {
    setTeslaError(null);
    try {
      const { url } = await api.teslaConnect();
      if (Platform.OS === 'web') globalThis.location.assign(url);
      else await Linking.openURL(url);
    } catch (e) {
      setTeslaError(e instanceof Error ? e.message : String(e));
    }
  }
  const irsRate = irsBusinessRateCents(today());
  const rateText = rate ?? (me?.customRateCents != null ? String(me.customRateCents) : '');

  async function saveRate() {
    const trimmed = rateText.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && !(value > 0)) return setRateError('Enter cents per mile, or leave blank for the IRS rate.');
    try {
      await api.updateSettings({ customRateCents: value });
      setRate(null);
      setRateError(undefined);
      reload();
    } catch (e) {
      setRateError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Screen>
      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {me ? (
        <Card style={{ gap: 4 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{me.name ?? 'Signed in'}</Text>
          {me.email ? <Muted>{me.email}</Muted> : null}
          <Muted>Time zone: {me.timezone}</Muted>
        </Card>
      ) : null}

      <Card style={{ gap: 12 }}>
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Mileage rate</Text>
        <Muted>
          IRS business rate today: {irsRate ?? '—'}¢/mi. Reports use the rate in effect on each trip date unless you set
          a custom rate.
        </Muted>
        <Field
          label="Custom rate (cents per mile)"
          placeholder="Leave blank for the IRS rate"
          keyboardType="decimal-pad"
          value={rateText}
          onChangeText={setRate}
          error={rateError}
        />
        <Button title="Save rate" kind="secondary" onPress={saveRate} disabled={rate === null} />
      </Card>

      <Card style={{ gap: 8 }}>
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Tesla</Text>
        {!tesla.configured ? (
          <Muted>Not set up yet. This turns on once Tesla approves the developer account.</Muted>
        ) : tesla.connected ? (
          <>
            <Muted>Connected. Trips in a linked Tesla read the odometer from the car.</Muted>
            <Button title="Reconnect Tesla" kind="secondary" onPress={connectTesla} />
          </>
        ) : (
          <>
            <Muted>Sign in to Tesla once so trips read the car's odometer and location.</Muted>
            <Button title="Connect Tesla" onPress={connectTesla} />
          </>
        )}
        {teslaError ? <Text style={{ color: colors.danger }}>{teslaError}</Text> : null}
      </Card>

      <Card>
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Vehicles</Text>
        {vehicles.length === 0 ? <Muted>No vehicles yet.</Muted> : null}
        {vehicles.map((v) => (
          <VehicleRow key={v.id} vehicle={v} onChanged={reload} />
        ))}
        <VehicleForm onSaved={reload} />
      </Card>

      <Button title="Sign out" kind="danger" onPress={() => void signOut()} />
    </Screen>
  );
}
