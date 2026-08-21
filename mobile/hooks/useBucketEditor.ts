import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { Bucket, BUCKET_LABEL } from '@/lib/buckets';
import { BucketLockedError } from '@/lib/vacationErrors';
import { useToast } from '@/components/ToastProvider';

export interface BucketEditorTarget {
  // A combined split is one row over several transactions, so re-tagging it
  // has to move every member — hence a list rather than a single id.
  ids: string[];
  merchantName: string;
  bucket: Bucket;
  locked: boolean;
}

/**
 * The bucket-editing plumbing shared by the Spending, Transactions, and
 * History screens: which transaction is being edited, presenting the sheet
 * once it has rendered, and the write with its error handling.
 *
 * `write` is the screen's own store action, so each screen keeps control of
 * what a write means and what gets reloaded afterwards.
 */
export function useBucketEditor(
  write: (ids: string[], bucket: Bucket) => Promise<void>,
  onDone?: () => void | Promise<void>
) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const [target, setTarget] = useState<BucketEditorTarget | null>(null);
  const [pendingPresent, setPendingPresent] = useState(false);
  const toast = useToast();

  // Present from an effect, after the sheet has rendered with the chosen
  // target. BucketPickerSheet returns null while it has no bucket, so on the
  // first tap sheetRef.current is still null and a synchronous present()
  // silently does nothing — the same reason the friend picker defers.
  useEffect(() => {
    if (!pendingPresent) return;
    sheetRef.current?.present();
    setPendingPresent(false);
  }, [pendingPresent]);

  const open = useCallback((next: BucketEditorTarget) => {
    setTarget(next);
    setPendingPresent(true);
  }, []);

  const onSelect = useCallback(
    async (bucket: Bucket) => {
      if (!target) return;
      try {
        await write(target.ids, bucket);
        sheetRef.current?.dismiss();
        await onDone?.();
        toast.show(`Moved to ${BUCKET_LABEL[bucket]}`, 'success');
      } catch (err) {
        if (err instanceof BucketLockedError) toast.show(err.message, 'error');
        else toast.show('Could not change the category. Please try again.', 'error');
      }
    },
    [target, write, onDone, toast]
  );

  // Memoized so a screen that passes sheetProps straight into a memoized
  // sheet component doesn't force a re-render on every unrelated render of
  // the host — only when the target or the write/onDone/toast identity
  // actually changes.
  const sheetProps = useMemo(
    () => ({
      bucket: target?.bucket ?? null,
      merchantName: target?.merchantName ?? '',
      locked: target?.locked ?? false,
      onSelect,
    }),
    [target, onSelect]
  );

  return { open, sheetRef, sheetProps };
}
