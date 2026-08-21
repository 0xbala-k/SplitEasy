import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useSpendStore } from '@/stores/spendStore';
import { aggregateMonth, formatCents, formatMonthKey, SpendRowWithShare } from '@/lib/spend';
import {
  Bucket, BucketGroup, BUCKET_LABEL, GROUP_BUCKETS, GROUP_LABEL,
} from '@/lib/buckets';
import SpendingDonut, { SliceInput } from '@/components/SpendingDonut';
import { BucketChip } from '@/components/BucketChip';
import { BucketPickerSheet } from '@/components/BucketPickerSheet';
import { useBucketEditor } from '@/hooks/useBucketEditor';
import { BucketColors, Colors, GroupColors, Radius, Shadow, Spacing } from '@/lib/theme';

const GROUPS: BucketGroup[] = ['travel', 'needs', 'wants', 'misc'];

export default function SpendingScreen() {
  const topInset = useSafeAreaInsets().top;
  const { months, monthKey, drill, load, stepMonth, setDrill, setBucket } = useSpendStore();
  // Select the raw rows and aggregate in a memo. Selecting `s.current()`
  // directly would build a new object on every store read, and zustand's
  // reference-equality check would then re-render forever.
  const rows = useSpendStore((s) => s.rows);
  const month = useMemo(() => aggregateMonth(rows, monthKey), [rows, monthKey]);

  const [expanded, setExpanded] = useState<Bucket | null>(null);
  // setBucket already reloads the store, so the hook needs no onDone here.
  const editor = useBucketEditor(setBucket);

  // Recompute whenever the tab regains focus, so a split or skip made on
  // another tab is reflected without a manual refresh.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // setBucket() reloads the store, and a reload always resets `drill` to the
  // top level (see spendStore.load) since re-tagging can empty out the group
  // the user was looking at. Follow that reset here too, so a stale expanded
  // bucket from a previous drill-in doesn't silently reappear "open" the next
  // time the user drills into the same group.
  useEffect(() => {
    if (!drill) setExpanded(null);
  }, [drill]);

  const atOldest = months.indexOf(monthKey) === months.length - 1;
  const atNewest = months.indexOf(monthKey) <= 0;

  // Top level shows the four groups; drilled in, the group's own buckets.
  const slices: SliceInput[] = drill
    ? GROUP_BUCKETS[drill].map((b) => ({
        key: b, label: BUCKET_LABEL[b], cents: month.byBucket[b], color: BucketColors[b],
      }))
    : GROUPS.map((g) => ({
        key: g, label: GROUP_LABEL[g], cents: month.byGroup[g], color: GroupColors[g],
      }));

  const centerCents = drill ? month.byGroup[drill] : month.totalCents;
  // The month itself is already shown (and navigable) in the header above, so
  // repeating it as the donut's caption would just be the same text twice on
  // screen — say what the number *is* instead.
  const centerCaption = drill ? GROUP_LABEL[drill] : 'Total spent';

  function onSlicePress(key: string) {
    // Only a group with more than one bucket is worth drilling into.
    const group = key as BucketGroup;
    if (!drill && GROUP_BUCKETS[group]?.length > 1) setDrill(group);
  }

  function openEditor(r: SpendRowWithShare) {
    editor.open({
      ids: [r.id],
      merchantName: r.merchant_name,
      bucket: r.bucket,
      locked: !!r.vacation_id,
    });
  }

  const listBuckets: Bucket[] = drill ? GROUP_BUCKETS[drill] : [];
  const rowsFor = (b: Bucket) => month.rows.filter((r) => r.bucket === b);

  if (months.length === 0) {
    return (
      <View style={[styles.root, { paddingTop: topInset + Spacing.lg }]}>
        <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
        <Text style={styles.title}>Spending</Text>
        <Text style={styles.empty}>
          Nothing yet. Skip or split a transaction and it will show up here.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: topInset + Spacing.lg }]}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />

      <View style={styles.monthRow}>
        <Pressable
          onPress={() => stepMonth(-1)}
          disabled={atOldest}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Previous month"
        >
          <Ionicons
            name="chevron-back"
            size={22}
            color={atOldest ? Colors.textTertiary : Colors.textPrimary}
          />
        </Pressable>
        <Text style={styles.monthLabel}>{formatMonthKey(monthKey)}</Text>
        <Pressable
          onPress={() => stepMonth(1)}
          disabled={atNewest}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Next month"
        >
          <Ionicons
            name="chevron-forward"
            size={22}
            color={atNewest ? Colors.textTertiary : Colors.textPrimary}
          />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <SpendingDonut
          slices={slices}
          centerLabel={formatCents(centerCents, month.currency)}
          centerCaption={centerCaption}
          onSlicePress={onSlicePress}
        />

        {month.otherCurrencies.length > 0 && (
          <Text style={styles.footnote}>
            {month.otherCurrencies
              .map((c) => `+ ${formatCents(c.cents, c.currency)} ${c.currency}`)
              .join('   ')}
          </Text>
        )}

        {drill && (
          <Pressable
            style={styles.backRow}
            onPress={() => { setDrill(null); setExpanded(null); }}
            accessibilityRole="button"
            accessibilityLabel="Back to all categories"
          >
            <Ionicons name="chevron-back" size={16} color={Colors.primary} />
            <Text style={styles.backText}>All categories</Text>
          </Pressable>
        )}

        <View style={styles.list}>
          {drill
            ? listBuckets.map((b) => (
                <View key={b}>
                  <Pressable
                    style={styles.bucketRow}
                    onPress={() => setExpanded(expanded === b ? null : b)}
                    accessibilityRole="button"
                    accessibilityLabel={`${BUCKET_LABEL[b]}, ${formatCents(month.byBucket[b], month.currency)}`}
                  >
                    <View style={[styles.dot, { backgroundColor: BucketColors[b] }]} />
                    <Text style={styles.bucketName} numberOfLines={1}>{BUCKET_LABEL[b]}</Text>
                    <Text style={styles.bucketAmount} numberOfLines={1}>
                      {formatCents(month.byBucket[b], month.currency)}
                    </Text>
                    <Ionicons
                      name={expanded === b ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color={Colors.textTertiary}
                    />
                  </Pressable>
                  {expanded === b && rowsFor(b).map((r) => (
                    <TransactionLine key={r.id} row={r} currency={month.currency} onEdit={openEditor} />
                  ))}
                </View>
              ))
            : GROUPS.map((g) => (
                <Pressable
                  key={g}
                  style={styles.bucketRow}
                  onPress={() => onSlicePress(g)}
                  accessibilityRole="button"
                  accessibilityLabel={`${GROUP_LABEL[g]}, ${formatCents(month.byGroup[g], month.currency)}`}
                >
                  <View style={[styles.dot, { backgroundColor: GroupColors[g] }]} />
                  <Text style={styles.bucketName} numberOfLines={1}>{GROUP_LABEL[g]}</Text>
                  <Text style={styles.bucketAmount} numberOfLines={1}>
                    {formatCents(month.byGroup[g], month.currency)}
                  </Text>
                  {GROUP_BUCKETS[g].length > 1 && (
                    <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
                  )}
                </Pressable>
              ))}
        </View>
      </ScrollView>

      <BucketPickerSheet ref={editor.sheetRef} {...editor.sheetProps} />
    </View>
  );
}

function TransactionLine({
  row, currency, onEdit,
}: {
  row: SpendRowWithShare;
  currency: string;
  onEdit: (r: SpendRowWithShare) => void;
}) {
  return (
    <View style={styles.txRow}>
      <View style={styles.txInfo}>
        <Text style={styles.txName} numberOfLines={1}>{row.merchant_name}</Text>
        <View style={styles.txMeta}>
          <BucketChip
            bucket={row.bucket}
            locked={!!row.vacation_id}
            onPress={() => onEdit(row)}
          />
        </View>
      </View>
      <Text style={styles.txAmount} numberOfLines={1}>
        {formatCents(row.shareCents, currency)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg, paddingHorizontal: Spacing.lg },
  title: { fontSize: 24, fontWeight: '700', color: Colors.textPrimary },
  empty: {
    fontSize: 14, color: Colors.textSecondary, marginTop: Spacing.lg, lineHeight: 20,
  },
  monthRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: Spacing.lg,
  },
  monthLabel: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  scroll: { paddingBottom: Spacing.xxl },
  footnote: {
    fontSize: 12, color: Colors.textTertiary, textAlign: 'center', marginTop: Spacing.xl,
  },
  backRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: Spacing.xl, gap: 2,
  },
  backText: { fontSize: 14, fontWeight: '600', color: Colors.primary },
  list: {
    marginTop: Spacing.lg, backgroundColor: Colors.surface,
    borderRadius: Radius.lg, paddingHorizontal: Spacing.lg, ...Shadow.sm,
  },
  bucketRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.lg, gap: Spacing.md,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  // minWidth 0 keeps RN-web from letting the amount crush this column; see the
  // min-width:auto note in the global constraints.
  bucketName: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600', color: Colors.textPrimary },
  bucketAmount: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary, flexShrink: 1 },
  txRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.md, paddingLeft: Spacing.xl,
    borderTopWidth: 1, borderTopColor: Colors.divider, gap: Spacing.md,
  },
  txInfo: { flex: 1, minWidth: 0 },
  txName: { fontSize: 14, color: Colors.textPrimary },
  txMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  txAmount: { fontSize: 14, fontWeight: '600', color: Colors.textSecondary, flexShrink: 1 },
});
