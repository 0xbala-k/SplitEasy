// mobile/components/ReviewActionSheet.tsx
import { forwardRef } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { ReviewItem } from '@/lib/types';
import { Colors, merchantColor } from '@/lib/theme';
import { actionSheetStyles as shared } from '@/components/actionSheetStyles';

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
        handleIndicatorStyle={shared.indicator}
        backgroundStyle={shared.sheetBg}
      >
        <BottomSheetView style={shared.container}>
          <View style={shared.summary}>
            <View style={[shared.avatar, { backgroundColor: avatarBg + '18' }]}>
              <Text style={[shared.avatarText, { color: avatarBg }]}>{initial}</Text>
            </View>
            <View style={shared.info}>
              <Text style={shared.merchant} numberOfLines={1}>{item.merchant_name}</Text>
              <Text style={shared.subtext}>
                {isAmountChanged
                  ? `$${oldAmount.toFixed(2)} → $${item.amount.toFixed(2)}`
                  : 'The pending charge never posted'}
              </Text>
            </View>
          </View>

          <Pressable
            style={({ pressed }) => [shared.action, pressed && shared.actionPressed]}
            onPress={onAccept}
            accessibilityRole="button"
            accessibilityLabel={acceptLabel}
          >
            <Ionicons
              name={isAmountChanged ? 'sync-outline' : 'trash-outline'}
              size={20}
              color={isAmountChanged ? Colors.textPrimary : Colors.error}
            />
            <Text style={[shared.actionText, !isAmountChanged && shared.destructiveText]}>
              {acceptLabel}
            </Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [shared.action, pressed && shared.actionPressed]}
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel={`Edit split for ${item.merchant_name}`}
          >
            <Ionicons name="create-outline" size={20} color={Colors.textPrimary} />
            <Text style={shared.actionText}>Edit split</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [shared.action, pressed && shared.actionPressed]}
            onPress={onReject}
            accessibilityRole="button"
            accessibilityLabel={rejectLabel}
          >
            <Ionicons name="close-circle-outline" size={20} color={Colors.textSecondary} />
            <Text style={shared.actionText}>{rejectLabel}</Text>
          </Pressable>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);
