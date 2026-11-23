import { router } from 'expo-router';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { TripControl } from '@/components/TripControl';
import { TripRow } from '@/components/TripRow';
import { Button, Card, ErrorBanner, Loading, Muted, colors, styles } from '@/components/ui';
import { useApi } from '@/lib/api';
import { formatMiles, formatMoney, monthLabel, monthRange, today } from '@/lib/dates';
import { useLoad } from '@/lib/useLoad';

export default function Today() {
  const api = useApi();
  const range = monthRange(today());
  const { data, error, loading, reload } = useLoad(
    () =>
      Promise.all([
        api.summary(range),
        api.trips(range),
        api.activeTrip(),
        api.vehicles(),
        api.teslaStatus().catch(() => ({ configured: false, connected: false })),
      ]),
    [api, range.from],
  );

  if (!data && loading) return <Loading />;
  const [summary, trips, active, vehicles, tesla] = data ?? [null, [], { trip: null }, [], { configured: false, connected: false }];
  const unclassified = trips.filter((t) => t.classification === 'unclassified').length;

  return (
    <ScrollView
      style={styles.screenScroll}
      contentContainerStyle={styles.screenContent}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
    >
      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {data ? (
        <TripControl active={active.trip} vehicles={vehicles} teslaConnected={tesla.connected} onChanged={reload} />
      ) : null}
      {summary ? (
        <Card>
          <Muted>{monthLabel(range.from)} to date</Muted>
          <Text style={{ fontSize: 40, fontWeight: '800', color: colors.primary, marginTop: 4 }}>
            {formatMiles(summary.totals.business)} mi
          </Text>
          <Text style={{ fontSize: 16, color: colors.text }}>
            business · {formatMoney(summary.totals.businessValueCents)} at the IRS rate
          </Text>
          <View style={{ flexDirection: 'row', gap: 16, marginTop: 12 }}>
            <Muted>{formatMiles(summary.totals.personal)} mi personal</Muted>
            <Muted>{summary.totals.trips} trips</Muted>
          </View>
        </Card>
      ) : null}

      {unclassified > 0 || (summary?.incompleteBusinessTrips ?? 0) > 0 ? (
        <Card style={{ borderColor: colors.commute }}>
          {unclassified > 0 ? (
            <Text style={{ color: colors.text }}>
              {unclassified} trip{unclassified === 1 ? '' : 's'} to classify
            </Text>
          ) : null}
          {summary && summary.incompleteBusinessTrips > 0 ? (
            <Text style={{ color: colors.text }}>
              {summary.incompleteBusinessTrips} business trip{summary.incompleteBusinessTrips === 1 ? '' : 's'} missing a
              destination or purpose
            </Text>
          ) : null}
        </Card>
      ) : null}

      <Button
        title="Add a past trip"
        kind="secondary"
        onPress={() => router.push({ pathname: '/trip/[id]', params: { id: 'new' } })}
      />

      <Card>
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Recent trips</Text>
        {trips.length === 0 ? <Muted>No trips yet this month.</Muted> : null}
        {trips.slice(0, 5).map((t) => (
          <TripRow key={t.id} trip={t} />
        ))}
      </Card>
    </ScrollView>
  );
}
