import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Transaction } from '@/lib/types';

interface Props {
  transaction: Transaction;
  onSkip: () => void;
  onSplit: () => void;
}

export function TransactionRow({ transaction, onSkip, onSplit }: Props) {
  const amount = `$${transaction.amount.toFixed(2)}`;
  const date = new Date(transaction.date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });

  return (
    <View style={styles.card}>
      <View style={styles.info}>
        <Text style={styles.merchant} numberOfLines={1}>{transaction.merchant_name}</Text>
        <Text style={styles.date}>{date}</Text>
      </View>
      <Text style={styles.amount}>{amount}</Text>
      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.skip]} onPress={onSkip}>
          <Text style={styles.skipText}>Skip</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.split]} onPress={onSplit}>
          <Text style={styles.splitText}>Split</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  info: { flex: 1, marginRight: 8 },
  merchant: { fontSize: 15, fontWeight: '600', color: '#111' },
  date: { fontSize: 12, color: '#888', marginTop: 2 },
  amount: { fontSize: 15, fontWeight: '700', color: '#111', marginRight: 12 },
  actions: { flexDirection: 'row', gap: 8 },
  btn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  skip: { backgroundColor: '#f0f0f0' },
  split: { backgroundColor: '#007AFF' },
  skipText: { fontSize: 13, color: '#555' },
  splitText: { fontSize: 13, color: '#fff', fontWeight: '600' },
});
