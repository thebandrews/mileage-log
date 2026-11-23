import { localDate, localTime, type Trip } from '@mileage/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, useApi } from '@/lib/api';
import { deviceTimezone, formatMiles } from '@/lib/dates';
import { Card, colors } from './ui';

/**
 * Trips waiting for Business or Personal. Personal is one tap; Business is one tap when the trip
 * already has a destination and purpose, otherwise it opens the trip to add them.
 */
export function Inbox({ trips, onChanged }: { trips: Trip[]; onChanged: () => void }) {
  const api = useApi();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (trips.length === 0) return null;
  const tz = deviceTimezone();

  async function classify(trip: Trip, classification: 'business' | 'personal') {
    setError(null);
    if (classification === 'business' && !(trip.endLabel?.trim() && trip.purpose?.trim())) {
      router.push({ pathname: '/trip/[id]', params: { id: trip.id, classify: '1', as: 'business' } });
      return;
    }
    setBusy(trip.id);
    try {
      await api.classify(trip.id, classification);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        router.push({ pathname: '/trip/[id]', params: { id: trip.id, classify: '1', as: classification } });
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card style={{ gap: 4, borderColor: colors.commute, borderWidth: 1.5 }}>
      <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
        {trips.length} trip{trips.length === 1 ? '' : 's'} to classify
      </Text>
      {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
      {trips.map((t) => (
        <View key={t.id} style={s.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Opens the trip"
            onPress={() => router.push({ pathname: '/trip/[id]', params: { id: t.id, classify: '1' } })}
            style={({ pressed }) => [{ flex: 1, gap: 2 }, pressed && { opacity: 0.6 }]}
          >
            <Text style={s.route} numberOfLines={1}>
              {[t.startLabel, t.endLabel].filter(Boolean).join(' → ') || 'No locations'}
            </Text>
            <Text style={s.meta} numberOfLines={1}>
              {localDate(t.startedAt, tz) === localDate(new Date().toISOString(), tz) ? 'Today' : localDate(t.startedAt, tz)}{' '}
              {localTime(t.startedAt, tz)} · {formatMiles(t.miles)} mi
            </Text>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 6, opacity: busy === t.id ? 0.4 : 1 }}>
            <Chip label="Business" color={colors.business} disabled={busy !== null} onPress={() => void classify(t, 'business')} />
            <Chip label="Personal" color={colors.personal} disabled={busy !== null} onPress={() => void classify(t, 'personal')} />
          </View>
        </View>
      ))}
    </Card>
  );
}

function Chip({ label, color, disabled, onPress }: { label: string; color: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Mark as ${label}`}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [s.chip, { borderColor: color }, pressed && { backgroundColor: color + '22' }]}
    >
      <Text style={[s.chipText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  route: { fontSize: 15, fontWeight: '600', color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
  chip: { borderWidth: 1.5, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { fontSize: 13, fontWeight: '700' },
});
