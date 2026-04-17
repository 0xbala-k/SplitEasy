import { useState, useCallback } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { getHistoryTransactions } from '@/lib/db';
import { TransactionWithSplit } from '@/lib/types';

export default function HistoryScreen() {
  const [rows, setRows] = useState<TransactionWithSplit[]>([]);

  useFocusEffect(
    useCallback(() => {
      getHistoryTransactions().then(setRows);
    }, [])
  );

  if (rows.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyIcon}>🕘</Text>
        <Text style={styles.emptyTitle}>No history yet</Text>
        <Text style={styles.emptySubtitle}>Split or skip transactions to see them here.</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => <HistoryRow item={item} />}
    />
  );
}

function HistoryRow({ item }: { item: TransactionWithSplit }) {
  const date = new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const isSplit = item.status === 'split' && item.split;

  return (
    <View style={styles.card}>
      <View style={styles.top}>
        <Text style={styles.merchant} numberOfLines={1}>{item.merchant_name}</Text>
        <Text style={styles.amount}>${item.amount.toFixed(2)}</Text>
      </View>
      <View style={styles.bottom}>
        <Text style={styles.date}>{date}</Text>
        {isSplit ? (
          <Text style={styles.splitLabel}>
            {item.split!.friend_names.join(', ')} · ${item.split!.amount_each.toFixed(2)} each
          </Text>
        ) : (
          <Text style={styles.skippedLabel}>Skipped</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#111' },
  emptySubtitle: { fontSize: 14, color: '#888', marginTop: 4, textAlign: 'center' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
  top: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  bottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  merchant: { fontSize: 15, fontWeight: '600', flex: 1, marginRight: 8 },
  amount: { fontSize: 15, fontWeight: '700' },
  date: { fontSize: 12, color: '#888' },
  splitLabel: { fontSize: 12, color: '#1c7c54', flex: 1, textAlign: 'right' },
  skippedLabel: { fontSize: 12, color: '#888' },
});
