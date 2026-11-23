import { Pressable, StyleSheet, Text, View } from 'react-native';
import { monthLabel, shiftMonth } from '@/lib/dates';
import { colors } from './ui';

/** "‹ November 2026 ›" — month is any date in the month, YYYY-MM-DD. */
export function MonthPicker({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <View style={s.row}>
      <Pressable accessibilityLabel="Previous month" onPress={() => onChange(shiftMonth(month, -1))} hitSlop={12}>
        <Text style={s.arrow}>‹</Text>
      </Pressable>
      <Text style={s.label}>{monthLabel(month)}</Text>
      <Pressable accessibilityLabel="Next month" onPress={() => onChange(shiftMonth(month, 1))} hitSlop={12}>
        <Text style={s.arrow}>›</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  arrow: { fontSize: 28, color: colors.primary, paddingHorizontal: 12 },
  label: { fontSize: 18, fontWeight: '700', color: colors.text },
});
