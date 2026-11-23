import { localTime, type Trip } from '@mileage/shared';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { deviceTimezone, formatMiles } from '@/lib/dates';
import { colors } from './ui';

const LABELS = { business: 'Business', personal: 'Personal', commute: 'Commute', unclassified: 'Unclassified' };

export function TripRow({ trip }: { trip: Trip }) {
  const incomplete = trip.classification === 'business' && !(trip.endLabel && trip.purpose);
  const route = [trip.startLabel, trip.endLabel].filter(Boolean).join(' → ') || 'No locations';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/trip/[id]', params: { id: trip.id } })}
      style={({ pressed }) => [s.row, pressed && { opacity: 0.6 }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.route} numberOfLines={1}>
          {route}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {localTime(trip.startedAt, deviceTimezone())}
          {trip.purpose ? ` · ${trip.purpose}` : ''}
        </Text>
        {incomplete ? <Text style={s.warn}>Needs destination and purpose</Text> : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text style={s.miles}>{formatMiles(trip.miles)} mi</Text>
        <Text style={[s.badge, { color: colors[trip.classification] }]}>{LABELS[trip.classification]}</Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  route: { fontSize: 16, fontWeight: '600', color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
  warn: { fontSize: 12, color: colors.danger },
  miles: { fontSize: 16, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  badge: { fontSize: 12, fontWeight: '600' },
});
