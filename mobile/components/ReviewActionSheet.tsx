// mobile/components/ReviewActionSheet.tsx
import { forwardRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { ReviewItem } from '@/lib/types';
import { Colors, Radius, Spacing, merchantColor } from '@/lib/theme';

interface Props {
  item: ReviewItem | null;
  onAccept: () => void;
  onEdit: () => void;
  onReject: () => void;
}

/**
 * The three outcomes for a "Needs review" row. Presentational only: every
 * label is derived from the item, and the host owns what each action does.
 * Structural twin of HistoryActionSheet — keep them in step.
 */
export const ReviewActionSheet = forwardRef<BottomSheetModal, Props>(
  ({ item, onAccept, onEdit, onReject }, ref) => {
    if (!item) return null;

    const isAmountChanged = item.reason === 'amount_changed';
    const oldAmount = item.amount_changed_from ?? 0;
    const initial = (item.merchant_name ?? '?')[0].toUpperCase();
    const avatarBg = merchantColor(item.merchant_name ?? '?');

    const acceptLabel = isAmountChanged
      ? `Update Splitwise to $${item.amount.toFixed(2)}`
      : 'Delete expense';
    const rejectLabel = isAmountChanged ? `Keep $${oldAmount.toFixed(2)}` : 'Keep the split';

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['42%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
      >
        <BottomSheetView style={styles.container}>
          <View style={styles.summary}>
            <View style={[styles.avatar, { backgroundColor: avatarBg + '18' }]}>
              <Text style={[styles.avatarText, { color: avatarBg }]}>{initial}</Text>
            </View>
            <View style={styles.info}>
              <Text style={styles.merchant} numberOfLines={1}>{item.merchant_name}</Text>
              <Text style={styles.detail}>
                {isAmountChanged
                  ? `$${oldAmount.toFixed(2)} → $${item.amount.toFixed(2)}`
                  : 'The pending charge never posted'}
              </Text>
            </View>
          </View>

          <Pressable
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            onPress={onAccept}
            accessibilityRole="button"
            accessibilityLabel={acceptLabel}
          >
            <Ionicons
              name={isAmountChanged ? 'sync-outline' : 'trash-outline'}
              size={20}
              color={isAmountChanged ? Colors.textPrimary : Colors.error}
            />
            <Text style={[styles.actionText, !isAmountChanged && styles.destructiveText]}>
              {acceptLabel}
            </Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel={`Edit split for ${item.merchant_name}`}
          >
            <Ionicons name="create-outline" size={20} color={Colors.textPrimary} />
            <Text style={styles.actionText}>Edit split</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            onPress={onReject}
            accessibilityRole="button"
            accessibilityLabel={rejectLabel}
          >
            <Ionicons name="close-circle-outline" size={20} color={Colors.textSecondary} />
            <Text style={styles.actionText}>{rejectLabel}</Text>
          </Pressable>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

const styles = StyleSheet.create({
  indicator: { backgroundColor: Colors.border, width: 36 },
  sheetBg: { backgroundColor: Colors.surface },
  container: { flex: 1, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  summary: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.lg },
  avatar: {
    width: 44, height: 44, borderRadius: Radius.md,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  avatarText: { fontSize: 17, fontWeight: '700' },
  info: { flex: 1 },
  merchant: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  detail: { fontSize: 14, color: Colors.textSecondary, marginTop: 2 },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.md,
    borderRadius: Radius.md, backgroundColor: Colors.surfaceMuted, marginBottom: Spacing.sm,
  },
  actionPressed: { backgroundColor: Colors.border },
  actionText: { fontSize: 16, fontWeight: '600', color: Colors.textPrimary },
  destructiveText: { color: Colors.error },
});
