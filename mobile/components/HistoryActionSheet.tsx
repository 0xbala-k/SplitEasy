// mobile/components/HistoryActionSheet.tsx
import { forwardRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { HistoryItem } from '@/lib/types';
import { Colors, Radius, Spacing, merchantColor } from '@/lib/theme';

interface Props {
  transaction: HistoryItem | null;
  onEdit: () => void;
  onDelete: () => void;
  onRestore?: () => void;
  // 'readOnly': an imported Splitwise expense belongs to whoever paid for it —
  // the app must never offer to rewrite or delete it upstream.
  // 'excluded': a soft-deleted transaction — the only action is Restore.
  mode?: 'default' | 'readOnly' | 'excluded';
}

export const HistoryActionSheet = forwardRef<BottomSheetModal, Props>(
  ({ transaction, onEdit, onDelete, onRestore, mode = 'default' }, ref) => {
    if (!transaction) return null;

    const readOnly = mode === 'readOnly';
    const excluded = mode === 'excluded';

    const initial = (transaction.merchant_name ?? '?')[0].toUpperCase();
    const avatarBg = merchantColor(transaction.merchant_name ?? '?');

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={[mode === 'default' ? '38%' : '30%']}
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
              <Text style={styles.merchant} numberOfLines={1}>{transaction.merchant_name}</Text>
              <Text style={styles.amount}>${transaction.amount.toFixed(2)}</Text>
            </View>
          </View>

          {excluded ? (
            <Pressable
              style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
              onPress={onRestore}
              accessibilityRole="button"
              accessibilityLabel={`Restore ${transaction.merchant_name}`}
            >
              <Ionicons name="refresh-outline" size={20} color={Colors.textPrimary} />
              <Text style={styles.actionText}>Restore</Text>
            </Pressable>
          ) : (
            <>
              {!readOnly && (
                <Pressable
                  style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                  onPress={onEdit}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit split for ${transaction.merchant_name}`}
                >
                  <Ionicons name="create-outline" size={20} color={Colors.textPrimary} />
                  <Text style={styles.actionText}>Edit split</Text>
                </Pressable>
              )}

              <Pressable
                style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                onPress={onDelete}
                accessibilityRole="button"
                accessibilityLabel={
                  readOnly
                    ? `Remove ${transaction.merchant_name} from SplitEasy`
                    : `Delete split for ${transaction.merchant_name}`
                }
              >
                <Ionicons name="trash-outline" size={20} color={Colors.error} />
                <Text style={[styles.actionText, styles.deleteText]}>
                  {readOnly ? 'Remove from SplitEasy' : 'Delete split'}
                </Text>
              </Pressable>
            </>
          )}
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

const styles = StyleSheet.create({
  indicator: { backgroundColor: Colors.border, width: 36 },
  sheetBg: { backgroundColor: Colors.surface },
  container: { flex: 1, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },

  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  avatarText: { fontSize: 17, fontWeight: '700' },
  info: { flex: 1 },
  merchant: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  amount: { fontSize: 14, color: Colors.textSecondary, marginTop: 2 },

  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: Colors.surfaceMuted,
    marginBottom: Spacing.sm,
  },
  actionPressed: { backgroundColor: Colors.border },
  actionText: { fontSize: 16, fontWeight: '600', color: Colors.textPrimary },
  deleteText: { color: Colors.error },
});
