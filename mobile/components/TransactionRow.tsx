import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Ionicons } from '@expo/vector-icons';
import { Transaction } from '@/lib/types';
import { formatDayLabel } from '@/lib/date';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';
import { Bucket } from '@/lib/buckets';
import { BucketChip } from '@/components/BucketChip';

interface Props {
  transaction: Transaction;
  onSkip: () => void;
  onSplit: () => void;
  // Supplied only in vacation mode. Its presence moves "remove from vacation"
  // onto the swipe underlay and keeps Skip inline, so a trip expense paid
  // entirely by the user can still be committed (and counted as Travel)
  // instead of only being splittable or ejectable.
  onRemove?: () => void;
  onLongPress?: () => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  // The bucket to display. On the Transactions tab this is a live guess and
  // nothing has been written yet; the write happens on skip or split.
  bucket?: Bucket;
  bucketLocked?: boolean;
  onBucketPress?: () => void;
}

export function TransactionRow({
  transaction, onSkip, onSplit, onRemove, onLongPress,
  selectMode, selected, onToggleSelect,
  bucket, bucketLocked, onBucketPress,
}: Props) {
  const amount = `$${transaction.amount.toFixed(2)}`;
  const date = formatDayLabel(transaction.date);
  const initial = (transaction.merchant_name ?? '?')[0].toUpperCase();
  const avatarBg = merchantColor(transaction.merchant_name ?? '?');
  const skipLabel = `Skip ${transaction.merchant_name}`;
  const removeLabel = `Remove ${transaction.merchant_name} from vacation`;

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

  const underlayAction = onRemove ?? onSkip;
  const renderUnderlay = () => (
    <Pressable
      style={styles.skipUnderlay}
      onPress={underlayAction}
      accessibilityRole="button"
      accessibilityLabel={onRemove ? removeLabel : skipLabel}
      // Inert at runtime, invisible to assistive tech — exists only so tests can
      // target this Pressable specifically. In the default branch it shares its
      // accessibilityLabel with the inline Skip button (both genuinely mean
      // "Skip {merchant}"), so a testID is what lets a query pick one over the
      // other rather than the production markup having to disambiguate itself.
      testID="swipe-underlay"
    >
      <Ionicons
        name={onRemove ? 'trash-outline' : 'close-circle-outline'}
        size={22}
        color={Colors.textSecondary}
      />
      <Text style={styles.skipUnderlayText}>{onRemove ? 'Remove' : 'Skip'}</Text>
    </Pressable>
  );

  return (
    <ReanimatedSwipeable
      renderLeftActions={renderUnderlay}
      onSwipeableOpen={(direction) => {
        // 'left' = the left underlay opened, i.e. the user swiped right
        if (direction === 'left') underlayAction();
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
            {bucket && (
              <BucketChip bucket={bucket} locked={bucketLocked} onPress={onBucketPress} />
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
            <Ionicons name="close-outline" size={14} color={Colors.textSecondary} />
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
