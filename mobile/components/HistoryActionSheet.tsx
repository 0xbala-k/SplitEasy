// mobile/components/HistoryActionSheet.tsx
import { forwardRef } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { HistoryItem } from '@/lib/types';
import { Colors, merchantColor } from '@/lib/theme';
import { actionSheetStyles as shared } from '@/components/actionSheetStyles';

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
        handleIndicatorStyle={shared.indicator}
        backgroundStyle={shared.sheetBg}
      >
        <BottomSheetView style={shared.container}>
          <View style={shared.summary}>
            <View style={[shared.avatar, { backgroundColor: avatarBg + '18' }]}>
              <Text style={[shared.avatarText, { color: avatarBg }]}>{initial}</Text>
            </View>
            <View style={shared.info}>
              <Text style={shared.merchant} numberOfLines={1}>{transaction.merchant_name}</Text>
              <Text style={shared.subtext}>${transaction.amount.toFixed(2)}</Text>
            </View>
          </View>

          {excluded ? (
            <Pressable
              style={({ pressed }) => [shared.action, pressed && shared.actionPressed]}
              onPress={onRestore}
              accessibilityRole="button"
              accessibilityLabel={`Restore ${transaction.merchant_name}`}
            >
              <Ionicons name="refresh-outline" size={20} color={Colors.textPrimary} />
              <Text style={shared.actionText}>Restore</Text>
            </Pressable>
          ) : (
            <>
              {!readOnly && (
                <Pressable
                  style={({ pressed }) => [shared.action, pressed && shared.actionPressed]}
                  onPress={onEdit}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit split for ${transaction.merchant_name}`}
                >
                  <Ionicons name="create-outline" size={20} color={Colors.textPrimary} />
                  <Text style={shared.actionText}>Edit split</Text>
                </Pressable>
              )}

              <Pressable
                style={({ pressed }) => [shared.action, pressed && shared.actionPressed]}
                onPress={onDelete}
                accessibilityRole="button"
                accessibilityLabel={
                  readOnly
                    ? `Remove ${transaction.merchant_name} from SplitEasy`
                    : `Delete split for ${transaction.merchant_name}`
                }
              >
                <Ionicons name="trash-outline" size={20} color={Colors.error} />
                <Text style={[shared.actionText, shared.destructiveText]}>
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
