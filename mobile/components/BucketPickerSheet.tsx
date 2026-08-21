import { forwardRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { Bucket, BUCKETS, BUCKET_LABEL } from '@/lib/buckets';
import { BucketColors, Colors, Radius, Spacing } from '@/lib/theme';

interface Props {
  bucket: Bucket | null;
  merchantName: string;
  locked?: boolean;
  onSelect: (bucket: Bucket) => void;
  onRemoveFromVacation?: () => void;
}

export const BucketPickerSheet = forwardRef<BottomSheetModal, Props>(
  ({ bucket, merchantName, locked, onSelect, onRemoveFromVacation }, ref) => {
    if (!bucket) return null;

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={[locked ? '32%' : '58%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
      >
        <BottomSheetView style={styles.container}>
          <Text style={styles.title} numberOfLines={1}>{merchantName}</Text>

          {locked ? (
            <>
              <Text style={styles.lockedBody}>
                This transaction is part of a vacation, so it counts as Travel.
                Remove it from the vacation to categorize it yourself.
              </Text>
              {onRemoveFromVacation && (
                <Pressable
                  style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                  onPress={onRemoveFromVacation}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${merchantName} from vacation`}
                >
                  <Ionicons name="airplane-outline" size={18} color={Colors.error} />
                  <Text style={[styles.optionText, styles.removeText]}>Remove from vacation</Text>
                </Pressable>
              )}
            </>
          ) : (
            BUCKETS.map((b) => (
              <Pressable
                key={b}
                style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                onPress={() => onSelect(b)}
                accessibilityRole="button"
                accessibilityLabel={`Move ${merchantName} to ${BUCKET_LABEL[b]}`}
              >
                <View style={[styles.dot, { backgroundColor: BucketColors[b] }]} />
                <Text style={styles.optionText}>{BUCKET_LABEL[b]}</Text>
                {b === bucket && (
                  <Ionicons name="checkmark" size={18} color={Colors.primary} style={styles.check} />
                )}
              </Pressable>
            ))
          )}
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

BucketPickerSheet.displayName = 'BucketPickerSheet';

const styles = StyleSheet.create({
  indicator: { backgroundColor: Colors.border, width: 36 },
  sheetBg: { backgroundColor: Colors.surface },
  container: { flex: 1, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  title: {
    fontSize: 15, fontWeight: '700', color: Colors.textPrimary, marginBottom: Spacing.md,
  },
  lockedBody: {
    fontSize: 13, color: Colors.textSecondary, lineHeight: 19, marginBottom: Spacing.md,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.sm,
  },
  optionPressed: { backgroundColor: Colors.surfaceMuted },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: Spacing.md },
  optionText: { flex: 1, minWidth: 0, fontSize: 15, color: Colors.textPrimary },
  removeText: { color: Colors.error, marginLeft: Spacing.md },
  check: { marginLeft: Spacing.sm },
});
