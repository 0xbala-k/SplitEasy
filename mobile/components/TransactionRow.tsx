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
  onLongPress?: () => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  variant?: 'skip' | 'remove';
}

export function TransactionRow({ transaction, onSkip, onSplit, onLongPress, selectMode, selected, onToggleSelect, variant = 'skip' }: Props) {
  const amount = `$${transaction.amount.toFixed(2)}`;
  const date = new Date(transaction.date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  const initial = (transaction.merchant_name ?? '?')[0].toUpperCase();
  const avatarBg = merchantColor(transaction.merchant_name ?? '?');
  const removeMode = variant === 'remove';
  const skipIcon = removeMode ? 'trash-outline' : 'close-circle-outline';
  const skipBtnIcon = removeMode ? 'trash-outline' : 'close-outline';
  const skipLabel = removeMode ? `Remove ${transaction.merchant_name} from vacation` : `Skip ${transaction.merchant_name}`;
  const skipUnderlayLabel = removeMode ? 'Remove' : 'Skip';

  if (selectMode) {
    return (
      <Pressable
        style={[styles.card, selected && styles.cardSelected]}
        onPress={onToggleSelect}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: !!selected }}
        accessibilityLabel={`Select ${transaction.merchant_name}`}
      >
        <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
          {selected && <Ionicons name="checkmark" size={14} color={Colors.textInverse} />}
        </View>
        <View style={[styles.avatar, { backgroundColor: avatarBg + '18' }]}>
          <Text style={[styles.avatarText, { color: avatarBg }]}>{initial}</Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.merchant} numberOfLines={1}>{transaction.merchant_name}</Text>
          <Text style={styles.date} numberOfLines={1}>{date}</Text>
        </View>
        <Text style={styles.amount} numberOfLines={1}>{amount}</Text>
      </Pressable>
    );
  }

  const renderSkipUnderlay = () => (
    <Pressable
      style={styles.skipUnderlay}
      onPress={onSkip}
      accessibilityRole="button"
      accessibilityLabel={skipLabel}
    >
      <Ionicons name={skipIcon} size={22} color={Colors.textSecondary} />
      <Text style={styles.skipUnderlayText}>{skipUnderlayLabel}</Text>
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
      <Pressable style={styles.card} onLongPress={onLongPress} delayLongPress={300}>
        {/* Merchant avatar */}
        <View style={[styles.avatar, { backgroundColor: avatarBg + '18' }]}>
          <Text style={[styles.avatarText, { color: avatarBg }]}>{initial}</Text>
        </View>

        {/* Info */}
        <View style={styles.info}>
          <Text style={styles.merchant} numberOfLines={1}>{transaction.merchant_name}</Text>
          <View style={styles.dateRow}>
            <Text style={styles.date} numberOfLines={1}>{date}</Text>
            {transaction.pending && (
              <View style={styles.pendingBadge}>
                <Text style={styles.pendingText}>Pending</Text>
              </View>
            )}
          </View>
        </View>

        {/* Amount */}
        <Text style={styles.amount} numberOfLines={1}>{amount}</Text>

        {/* Actions */}
        <View style={styles.actions}>
          <Pressable
            style={({ pressed }) => [styles.btn, styles.skipBtn, pressed && styles.skipBtnPressed]}
            onPress={onSkip}
            accessibilityRole="button"
            accessibilityLabel={skipLabel}
          >
            <Ionicons name={skipBtnIcon} size={14} color={Colors.textSecondary} />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.btn, styles.splitBtn, pressed && styles.splitBtnPressed]}
            onPress={onSplit}
            onLongPress={onLongPress}
            delayLongPress={300}
            accessibilityRole="button"
            accessibilityLabel={`Split ${transaction.merchant_name}`}
          >
            <Ionicons name="people-outline" size={14} color={Colors.textInverse} style={{ marginRight: 3 }} />
            <Text style={styles.splitText}>Split</Text>
          </Pressable>
        </View>
      </Pressable>
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
  // minWidth keeps the merchant name legible when the amount is unusually wide:
  // without a floor, a large amount takes its intrinsic width first and crushes
  // this column to a few pixels. Keep the floor below the ~75px this column gets
  // naturally for a typical amount, or it steals width back and truncates every
  // amount instead.
  info: { flex: 1, minWidth: 64, marginRight: Spacing.sm },
  merchant: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  date: {
    fontSize: 12,
    color: Colors.textTertiary,
  },
  pendingBadge: {
    backgroundColor: Colors.warningLight,
    borderRadius: Radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 1,
    flexShrink: 0,
  },
  pendingText: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.warning,
  },
  amount: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginRight: Spacing.md,
    // Yields before the merchant name does, rather than pushing it off the row.
    flexShrink: 1,
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
  cardSelected: { backgroundColor: Colors.primaryMuted },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: Radius.sm,
    borderWidth: 1.5,
    borderColor: Colors.border,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    marginRight: Spacing.md,
  },
  checkboxSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
});
