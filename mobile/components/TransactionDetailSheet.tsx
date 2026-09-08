// mobile/components/TransactionDetailSheet.tsx
import React, { forwardRef, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetTextInput,
  BottomSheetFooter,
  type BottomSheetFooterProps,
} from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Transaction, SplitwiseInboxItem } from '@/lib/types';
import { Bucket } from '@/lib/buckets';
import { BucketChip } from '@/components/BucketChip';
import { Colors, Radius, Spacing, Shadow } from '@/lib/theme';
import { todayLocal } from '@/lib/date';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!DATE_ONLY_RE.test(value)) return false;
  return !isNaN(new Date(value + 'T00:00:00').getTime());
}

export type DetailSheetMode = 'create' | 'edit' | 'inbox';

export interface DetailSheetResult {
  merchant_name: string;
  amount: number;
  date: string;
  my_share?: number; // 'inbox' mode only
  bucket: Bucket;
}

export interface TransactionDetailSheetProps {
  mode: DetailSheetMode;
  transaction?: Transaction | null; // 'edit'
  inboxItem?: SplitwiseInboxItem | null; // 'inbox'
  bucket: Bucket;
  bucketLocked?: boolean;
  openToken: number;
  onSubmit: (result: DetailSheetResult) => void;
  onDelete?: () => void; // omit in 'create' mode; label follows the mode
  onBucketPress?: () => void; // ignored while bucketLocked
}

const SUBMIT_LABEL: Record<DetailSheetMode, string> = {
  create: 'Add',
  edit: 'Save',
  inbox: 'Accept',
};

/** Amounts live as strings so the input stays controlled; seeded to 2dp. */
function money(n: number | undefined): string {
  return n === undefined ? '' : n.toFixed(2);
}

function parseMoney(raw: string): number | null {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 'edit' mode allows a nonzero amount of either sign, since Plaid can report
 * a negative amount for a refund/credit and the user must still be able to
 * fix the merchant name or date on that row. 'create' and 'inbox' keep the
 * strict positive rule: a manual entry or an accepted Splitwise share should
 * never be zero or negative.
 */
function parseAmountForMode(raw: string, mode: DetailSheetMode): number | null {
  if (mode !== 'edit') return parseMoney(raw);
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

export const TransactionDetailSheet = forwardRef<BottomSheetModal, TransactionDetailSheetProps>(
  ({ mode, transaction, inboxItem, bucket, bucketLocked, openToken, onSubmit, onDelete, onBucketPress }, ref) => {
    const [name, setName] = useState('');
    const [amount, setAmount] = useState('');
    const [share, setShare] = useState('');
    const [date, setDate] = useState('');
    const insets = useSafeAreaInsets();

    // Reseed on every open. The parent bumps openToken rather than relying on
    // mount, because the modal is kept mounted between presentations.
    useEffect(() => {
      if (mode === 'edit' && transaction) {
        setName(transaction.merchant_name ?? '');
        setAmount(money(transaction.amount));
        setDate(transaction.date);
        setShare('');
      } else if (mode === 'inbox' && inboxItem) {
        setName(inboxItem.description);
        setAmount(money(inboxItem.cost));
        setShare(money(inboxItem.my_share));
        setDate(inboxItem.date);
      } else {
        setName('');
        setAmount('');
        setShare('');
        setDate(todayLocal());
      }
    }, [openToken, mode, transaction, inboxItem]);

    const parsedAmount = parseAmountForMode(amount, mode);
    const parsedShare = mode === 'inbox' ? parseMoney(share) : null;
    const valid = useMemo(
      () =>
        name.trim().length > 0 &&
        parsedAmount !== null &&
        isValidDate(date) &&
        (mode !== 'inbox' || parsedShare !== null),
      [name, parsedAmount, parsedShare, date, mode]
    );

    // Mirrors FriendPickerSheet: render nothing until the required prop for
    // this mode has arrived, so the parent's effect-driven present() is what
    // opens a fully-formed sheet.
    if (mode === 'edit' && !transaction) return null;
    if (mode === 'inbox' && !inboxItem) return null;

    function handleSubmit() {
      if (!valid || parsedAmount === null) return;
      onSubmit({
        merchant_name: name.trim(),
        amount: parsedAmount,
        date,
        ...(mode === 'inbox' && parsedShare !== null ? { my_share: parsedShare } : {}),
        bucket,
      });
    }

    // The CTA lives in footerComponent, never at the end of the body:
    // BottomSheetView breaks flex layout and a CTA in the body scrolls
    // off-screen on smaller devices.
    const renderFooter = (footerProps: BottomSheetFooterProps) => (
      <BottomSheetFooter {...footerProps} bottomInset={insets.bottom} style={styles.footer}>
        <Pressable
          style={[styles.submit, !valid && styles.submitDisabled]}
          onPress={handleSubmit}
          disabled={!valid}
          accessibilityRole="button"
          accessibilityState={{ disabled: !valid }}
        >
          <Text style={styles.submitText}>{SUBMIT_LABEL[mode]}</Text>
        </Pressable>
      </BottomSheetFooter>
    );

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={[mode === 'inbox' ? '62%' : '54%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        footerComponent={renderFooter}
      >
        <BottomSheetScrollView style={styles.body}>
          <Text style={styles.label}>Merchant</Text>
          <BottomSheetTextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            accessibilityLabel="Merchant"
            placeholder="Where did you spend?"
          />

          <Text style={styles.label}>Amount</Text>
          <BottomSheetTextInput
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            accessibilityLabel="Amount"
            placeholder="0.00"
          />

          {mode === 'inbox' && (
            <>
              <Text style={styles.label}>Your share</Text>
              <BottomSheetTextInput
                style={styles.input}
                value={share}
                onChangeText={setShare}
                keyboardType="decimal-pad"
                accessibilityLabel="Your share"
                placeholder="0.00"
              />
            </>
          )}

          <Text style={styles.label}>Date</Text>
          <BottomSheetTextInput
            style={styles.input}
            value={date}
            onChangeText={setDate}
            accessibilityLabel="Date"
            placeholder="YYYY-MM-DD"
          />

          <Text style={styles.label}>Bucket</Text>
          <View accessibilityLabel="Bucket" accessibilityState={{ disabled: !!bucketLocked }}>
            <BucketChip bucket={bucket} locked={bucketLocked} onPress={bucketLocked ? undefined : onBucketPress} />
          </View>

          {onDelete && (
            <Pressable style={styles.delete} onPress={onDelete} accessibilityRole="button">
              <Text style={styles.deleteText}>{mode === 'inbox' ? 'Dismiss' : 'Delete'}</Text>
            </Pressable>
          )}
        </BottomSheetScrollView>
      </BottomSheetModal>
    );
  }
);

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xl,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: Spacing.xs,
    marginTop: Spacing.md,
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    fontSize: 15,
    color: Colors.textPrimary,
    backgroundColor: Colors.surface,
  },
  delete: {
    marginTop: Spacing.xl,
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  deleteText: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.error,
  },
  footer: {
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  submit: {
    flexDirection: 'row',
    paddingVertical: 16,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    ...Shadow.sm,
  },
  submitDisabled: {
    backgroundColor: Colors.surfaceMuted,
  },
  submitText: {
    color: Colors.textInverse,
    fontSize: 16,
    fontWeight: '700',
  },
});
