// mobile/components/ReceiptSummary.tsx
//
// Assign-stage summary for the Receipt split mode: itemized subtotal,
// editable tax/tip fields (Gemini extraction is unreliable, so these must be
// user-correctable), a receipt-total-vs-charged-amount reconciliation, and a
// "Retake photo" link. Purely presentational (see Task 5 brief) —
// FriendPickerSheet (Task 6) owns `taxCents`/`tipCents`/`useReceiptTotal`
// state and passes it in as props. Tax/tip fields follow the same
// local-state + commit-on-blur pattern as `CustomRow` in FriendPickerSheet.tsx.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius, Spacing } from '@/lib/theme';

interface Props {
  itemsTotalCents: number;
  taxCents: number;
  tipCents: number;
  onChangeTaxCents: (cents: number) => void;
  onChangeTipCents: (cents: number) => void;
  // The bank-charged amount (`totalAmount` in FriendPickerSheet) — what gets
  // sent to Splitwise unless `useReceiptTotal` overrides it.
  chargedCents: number;
  useReceiptTotal: boolean;
  onChangeUseReceiptTotal: (value: boolean) => void;
  onRetakePhoto: () => void;
}

function MoneyField({
  label,
  cents,
  onCommitCents,
}: {
  label: string;
  cents: number;
  onCommitCents: (cents: number) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState((cents / 100).toFixed(2));

  useEffect(() => {
    if (!focused) setText((cents / 100).toFixed(2));
  }, [cents, focused]);

  function handleBlur() {
    setFocused(false);
    const parsed = parseFloat(text);
    if (!isNaN(parsed) && parsed >= 0) {
      const rounded = Math.round(parsed * 100) / 100;
      onCommitCents(Math.round(rounded * 100));
      setText(rounded.toFixed(2));
    } else {
      // Invalid — revert to the last-committed value, same as CustomRow.
      setText((cents / 100).toFixed(2));
    }
  }

  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldInputWrap}>
        <Text style={styles.fieldDollar}>$</Text>
        <BottomSheetTextInput
          style={styles.fieldInput}
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          keyboardType="decimal-pad"
          selectTextOnFocus
          accessibilityLabel={label}
        />
      </View>
    </View>
  );
}

export function ReceiptSummary({
  itemsTotalCents,
  taxCents,
  tipCents,
  onChangeTaxCents,
  onChangeTipCents,
  chargedCents,
  useReceiptTotal,
  onChangeUseReceiptTotal,
  onRetakePhoto,
}: Props) {
  const receiptTotalCents = itemsTotalCents + taxCents + tipCents;
  const deltaCents = receiptTotalCents - chargedCents; // > 0: receipt exceeds the charge
  const showReconciliation = deltaCents !== 0;
  // Only the "receipt exceeds charge, still charging the bank amount" case
  // pushes the owner's share into the red (decision (A) in the plan) — a
  // receipt total below the charge is the existing, unchanged, non-error
  // "owner absorbs the difference" behavior.
  const overBudget = deltaCents > 0 && !useReceiptTotal;

  return (
    <View style={styles.container}>
      <View style={styles.itemsRow}>
        <Text style={styles.itemsLabel}>Items ${(itemsTotalCents / 100).toFixed(2)}</Text>
        <Text style={styles.dot}>·</Text>
        <MoneyField label="Tax" cents={taxCents} onCommitCents={onChangeTaxCents} />
        <Text style={styles.dot}>·</Text>
        <MoneyField label="Tip" cents={tipCents} onCommitCents={onChangeTipCents} />
      </View>

      <Text style={styles.totalsText}>
        Receipt total ${(receiptTotalCents / 100).toFixed(2)} · Charged $
        {(chargedCents / 100).toFixed(2)}
      </Text>

      {showReconciliation && (
        <Pressable
          style={[styles.ownerCard, overBudget && styles.ownerCardError]}
          onPress={() => onChangeUseReceiptTotal(!useReceiptTotal)}
          accessibilityRole="switch"
          accessibilityState={{ checked: useReceiptTotal }}
          accessibilityLabel="Charge the receipt total instead of the bank amount"
        >
          <View style={styles.ownerCardText}>
            <Text style={[styles.ownerLabel, overBudget && styles.ownerLabelError]}>
              {deltaCents > 0
                ? `Receipt is $${(deltaCents / 100).toFixed(2)} more than the charge`
                : `Receipt is $${(-deltaCents / 100).toFixed(2)} less than the charge`}
            </Text>
            <Text style={styles.ownerHint}>
              {useReceiptTotal ? 'Charging the receipt total' : 'Tap to charge the receipt total instead'}
            </Text>
          </View>
          <View style={[styles.checkbox, useReceiptTotal && styles.checkboxSelected]}>
            {useReceiptTotal && <Ionicons name="checkmark" size={13} color={Colors.textInverse} />}
          </View>
        </Pressable>
      )}

      <Pressable onPress={onRetakePhoto} accessibilityRole="button" accessibilityLabel="Retake photo">
        <Text style={styles.retakeText}>Retake photo</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: Spacing.md },

  itemsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  itemsLabel: { fontSize: 14, fontWeight: '600', color: Colors.textPrimary },
  dot: { fontSize: 14, color: Colors.textTertiary, marginHorizontal: Spacing.xs },

  fieldGroup: { flexDirection: 'row', alignItems: 'center' },
  fieldLabel: {
    fontSize: 13,
    color: Colors.textSecondary,
    fontWeight: '500',
    marginRight: Spacing.xs,
  },
  fieldInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceMuted,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm,
    minWidth: 64,
  },
  fieldDollar: { fontSize: 13, color: Colors.textSecondary, fontWeight: '500' },
  fieldInput: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textPrimary,
    fontVariant: ['tabular-nums'],
    minWidth: 44,
    paddingVertical: 6,
    paddingHorizontal: 2,
  },

  totalsText: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },

  ownerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.primaryMuted,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
  },
  ownerCardError: { backgroundColor: Colors.errorLight },
  ownerCardText: { flex: 1, marginRight: Spacing.sm },
  ownerLabel: { fontSize: 13, fontWeight: '600', color: Colors.primary },
  ownerLabelError: { color: Colors.error },
  ownerHint: { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: Radius.sm,
    borderWidth: 1.5,
    borderColor: Colors.border,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.surface,
  },
  checkboxSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },

  retakeText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.primary,
    textAlign: 'center',
  },
});
