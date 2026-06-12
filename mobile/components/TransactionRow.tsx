import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Ionicons } from '@expo/vector-icons';
import { Transaction } from '@/lib/types';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

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
  const initial = (transaction.merchant_name ?? '?')[0].toUpperCase();
  const avatarBg = merchantColor(transaction.merchant_name ?? '?');

  const renderSkipUnderlay = () => (
    <Pressable
      style={styles.skipUnderlay}
      onPress={onSkip}
      accessibilityRole="button"
      accessibilityLabel={`Skip ${transaction.merchant_name}`}
    >
      <Ionicons name="close-circle-outline" size={22} color={Colors.textSecondary} />
      <Text style={styles.skipUnderlayText}>Skip</Text>
    </Pressable>
  );

  return (
    <ReanimatedSwipeable
      renderLeftActions={renderSkipUnderlay}
      onSwipeableOpen={(direction) => {
        // 'left' = the left underlay opened, i.e. the user swiped right
        if (direction === 'left') onSkip();
      }}
      leftThreshold={72}
      friction={1.5}
    >
      <View style={styles.card}>
        {/* Merchant avatar */}
        <View style={[styles.avatar, { backgroundColor: avatarBg + '18' }]}>
          <Text style={[styles.avatarText, { color: avatarBg }]}>{initial}</Text>
        </View>

        {/* Info */}
        <View style={styles.info}>
          <Text style={styles.merchant} numberOfLines={1}>{transaction.merchant_name}</Text>
          <Text style={styles.date}>{date}</Text>
        </View>

        {/* Amount */}
        <Text style={styles.amount}>{amount}</Text>

        {/* Actions */}
        <View style={styles.actions}>
          <Pressable
            style={({ pressed }) => [styles.btn, styles.skipBtn, pressed && styles.skipBtnPressed]}
            onPress={onSkip}
            accessibilityRole="button"
            accessibilityLabel={`Skip ${transaction.merchant_name}`}
          >
            <Ionicons name="close-outline" size={14} color={Colors.textSecondary} />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.btn, styles.splitBtn, pressed && styles.splitBtnPressed]}
            onPress={onSplit}
            accessibilityRole="button"
            accessibilityLabel={`Split ${transaction.merchant_name}`}
          >
            <Ionicons name="people-outline" size={14} color={Colors.textInverse} style={{ marginRight: 3 }} />
            <Text style={styles.splitText}>Split</Text>
          </Pressable>
        </View>
      </View>
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    ...Shadow.sm,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  avatarText: {
    fontSize: 17,
    fontWeight: '700',
  },
  info: { flex: 1, marginRight: Spacing.sm },
  merchant: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.textPrimary,
    marginBottom: 2,
  },
  date: {
    fontSize: 12,
    color: Colors.textTertiary,
  },
  amount: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginRight: Spacing.md,
  },
  actions: { flexDirection: 'row', gap: 6 },
  btn: {
    borderRadius: Radius.md,
    paddingVertical: 7,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 34,
  },
  skipUnderlay: {
    width: 96,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surfaceMuted,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginRight: Spacing.sm,
  },
  skipUnderlayText: {
    fontSize: 13,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  skipBtn: { backgroundColor: Colors.surfaceMuted },
  skipBtnPressed: { backgroundColor: Colors.border },
  splitBtn: { backgroundColor: Colors.primary },
  splitBtnPressed: { backgroundColor: Colors.primaryDark },
  splitText: {
    fontSize: 13,
    color: Colors.textInverse,
    fontWeight: '600',
  },
});
