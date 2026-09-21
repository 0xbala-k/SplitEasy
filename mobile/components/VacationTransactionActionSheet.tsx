// mobile/components/VacationTransactionActionSheet.tsx
//
// Actions for an unsplit ("To split") transaction on the vacation detail
// page. Structural twin of HistoryActionSheet — same sheet shape, same
// null-transaction guard, same shared StyleSheet — but it acts on rows that
// have not been committed yet, where HistoryActionSheet acts on the already-
// split recap rows below them.
//
// Split is deliberately NOT offered here. It would have to dismiss this sheet
// and present FriendPickerSheet in its place, and that sheet-to-sheet handoff
// is the transition that previously stranded the bucket/vacation pickers. The
// row keeps its own inline Split button, which is the prominent action anyway.
import { forwardRef } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { Transaction } from '@/lib/types';
import { Colors, merchantColor } from '@/lib/theme';
import { actionSheetStyles as shared } from '@/components/actionSheetStyles';

interface Props {
  transaction: Transaction | null;
  /** Clears vacation_id, returning the row to the main Transactions tab. */
  onMoveOut: () => void;
  onSkip: () => void;
}

export const VacationTransactionActionSheet = forwardRef<BottomSheetModal, Props>(
  ({ transaction, onMoveOut, onSkip }, ref) => {
    if (!transaction) return null;

    const initial = (transaction.merchant_name ?? '?')[0].toUpperCase();
    const avatarBg = merchantColor(transaction.merchant_name ?? '?');

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['38%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        handleIndicatorStyle={shared.indicator}
        backgroundStyle={shared.sheetBg}
      >
        <BottomSheetView style={shared.container}>
          {/* The testID lives on a plain View, not on BottomSheetView: the
              bottom-sheet test mocks re-render their children in a bare View
              and drop the props, so a testID up there would not survive. */}
          <View testID="vacation-tx-action-sheet">
            <View style={shared.summary}>
              <View style={[shared.avatar, { backgroundColor: avatarBg + '18' }]}>
                <Text style={[shared.avatarText, { color: avatarBg }]}>{initial}</Text>
              </View>
              <View style={shared.info}>
                <Text style={shared.merchant} numberOfLines={1}>{transaction.merchant_name}</Text>
                <Text style={shared.subtext}>${transaction.amount.toFixed(2)}</Text>
              </View>
            </View>

            <Pressable
              style={({ pressed }) => [shared.action, pressed && shared.actionPressed]}
              onPress={onMoveOut}
              accessibilityRole="button"
              accessibilityLabel={`Move ${transaction.merchant_name} to Transactions`}
            >
              <Ionicons name="arrow-undo-outline" size={20} color={Colors.textPrimary} />
              <Text style={shared.actionText}>Move to Transactions</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [shared.action, pressed && shared.actionPressed]}
              onPress={onSkip}
              accessibilityRole="button"
              accessibilityLabel={`Skip ${transaction.merchant_name}`}
            >
              <Ionicons name="close-circle-outline" size={20} color={Colors.textPrimary} />
              <Text style={shared.actionText}>Skip</Text>
            </Pressable>
          </View>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);
