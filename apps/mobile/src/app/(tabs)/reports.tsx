import { useState } from 'react';
import { Alert, Platform, RefreshControl, ScrollView, Text, View } from 'react-native';
import { MonthPicker } from '@/components/MonthPicker';
import { Button, Card, ErrorBanner, Loading, Muted, colors, styles } from '@/components/ui';
import { useApi } from '@/lib/api';
import { dayLabel, formatMiles, formatMoney, monthRange, today } from '@/lib/dates';
import { saveAndShare } from '@/lib/download';
import { useLoad } from '@/lib/useLoad';

const ROWS = [
  ['Business', 'business'],
  ['Personal', 'personal'],
  ['Commute', 'commute'],
  ['Unclassified', 'unclassified'],
] as const;

function notify(title: string, message: string) {
  if (Platform.OS === 'web') globalThis.alert?.(`${title}\n${message}`);
  else Alert.alert(title, message);
}

export default function Reports() {
  const api = useApi();
  const [month, setMonth] = useState(() => monthRange(today()).from);
  const range = monthRange(month);
  const { data: summary, error, loading, reload } = useLoad(() => api.summary(range), [api, range.from]);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);

  async function exportLog(kind: 'csv' | 'pdf') {
    setExporting(kind);
    try {
      const res = await api.report(kind, range);
      await saveAndShare(
        res,
        `mileage-log_${range.from}_${range.to}.${kind}`,
        kind === 'pdf' ? 'application/pdf' : 'text/csv',
      );
    } catch (e) {
      notify('Export failed', e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(null);
    }
  }

  return (
    <ScrollView
      style={styles.screenScroll}
      contentContainerStyle={styles.screenContent}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
    >
      <MonthPicker month={month} onChange={setMonth} />
      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {!summary && loading ? <Loading /> : null}

      {summary ? (
        <>
          <Card style={{ gap: 8 }}>
            {ROWS.map(([label, key]) => (
              <View key={key} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors[key], fontWeight: '600' }}>{label}</Text>
                <Text style={{ color: colors.text, fontVariant: ['tabular-nums'] }}>{formatMiles(summary.totals[key])} mi</Text>
              </View>
            ))}
            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontWeight: '700', color: colors.text }}>Total · {summary.totals.trips} trips</Text>
              <Text style={{ fontWeight: '700', color: colors.text }}>{formatMiles(summary.totals.total)} mi</Text>
            </View>
            <Muted>Business value {formatMoney(summary.totals.businessValueCents)} at the IRS rate</Muted>
            {summary.incompleteBusinessTrips > 0 ? (
              <Text style={styles.error}>
                {summary.incompleteBusinessTrips} business trip(s) need a destination or purpose before this log is IRS-ready.
              </Text>
            ) : null}
          </Card>

          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Button title="Export PDF" onPress={() => exportLog('pdf')} busy={exporting === 'pdf'} disabled={!!exporting} />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Export CSV"
                kind="secondary"
                onPress={() => exportLog('csv')}
                busy={exporting === 'csv'}
                disabled={!!exporting}
              />
            </View>
          </View>

          <Card>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 8 }}>Daily log</Text>
            {summary.byDay.length === 0 ? <Muted>No trips this month.</Muted> : null}
            {summary.byDay.map((d) => (
              <View
                key={d.period}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  paddingVertical: 8,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.border,
                }}
              >
                <Text style={{ color: colors.text }}>{dayLabel(d.period)}</Text>
                <Text style={{ color: colors.muted, fontVariant: ['tabular-nums'] }}>
                  {formatMiles(d.business)} biz · {formatMiles(d.total)} total
                </Text>
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </ScrollView>
  );
}
