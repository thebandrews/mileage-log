import { localDate, type Trip } from '@mileage/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, SectionList, Text, View } from 'react-native';
import { MonthPicker } from '@/components/MonthPicker';
import { TripRow } from '@/components/TripRow';
import { ErrorBanner, Loading, Muted, colors, styles } from '@/components/ui';
import { useApi } from '@/lib/api';
import { dayLabel, deviceTimezone, formatMiles, monthRange, today } from '@/lib/dates';
import { useLoad } from '@/lib/useLoad';

function groupByDay(trips: Trip[]) {
  const tz = deviceTimezone();
  const days = new Map<string, Trip[]>();
  for (const t of trips) {
    const d = localDate(t.startedAt, tz);
    days.set(d, [...(days.get(d) ?? []), t]);
  }
  return [...days.entries()].map(([date, data]) => ({
    date,
    miles: data.reduce((sum, t) => sum + Math.round(t.miles * 10), 0) / 10,
    data,
  }));
}

export default function Trips() {
  const api = useApi();
  const [month, setMonth] = useState(() => monthRange(today()).from);
  const range = monthRange(month);
  const { data, error, loading, reload } = useLoad(() => api.trips(range), [api, range.from]);

  return (
    <View style={styles.screen}>
      <View style={{ padding: 16, paddingBottom: 8, gap: 8 }}>
        <MonthPicker month={month} onChange={setMonth} />
        {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      </View>
      {!data && loading ? (
        <Loading />
      ) : (
        <SectionList
          sections={groupByDay(data ?? [])}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 96 }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
          renderSectionHeader={({ section }) => (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 16, backgroundColor: colors.bg }}>
              <Text style={{ fontWeight: '700', color: colors.text }}>{dayLabel(section.date)}</Text>
              <Muted>{formatMiles(section.miles)} mi</Muted>
            </View>
          )}
          renderItem={({ item }) => <TripRow trip={item} />}
          ListEmptyComponent={<Muted>No trips this month.</Muted>}
          stickySectionHeadersEnabled
        />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add trip"
        onPress={() => router.push({ pathname: '/trip/[id]', params: { id: 'new' } })}
        style={{
          position: 'absolute',
          right: 20,
          bottom: 24,
          width: 60,
          height: 60,
          borderRadius: 30,
          backgroundColor: colors.primary,
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 3 },
          elevation: 4,
        }}
      >
        <Text style={{ color: colors.primaryText, fontSize: 32, lineHeight: 34 }}>+</Text>
      </Pressable>
    </View>
  );
}
