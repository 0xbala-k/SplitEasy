// mobile/components/ReceiptCapture.tsx
//
// Capture-stage header content for the Receipt split mode. Purely
// presentational (see Task 5 brief): it exposes the three actions (take
// photo / choose photo / skip) and a `scanning` flag for the status line —
// all photo-picking, `scanReceipt()` calls, item-seeding, and toasting are
// the caller's responsibility (FriendPickerSheet, Task 6).
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius, Spacing } from '@/lib/theme';

interface Props {
  scanning: boolean;
  onTakePhoto: () => void;
  onChoosePhoto: () => void;
  onSkip: () => void;
}

export function ReceiptCapture({ scanning, onTakePhoto, onChoosePhoto, onSkip }: Props) {
  // Desktop Chrome's `capture` attribute on a file input silently degrades to
  // a plain file dialog when there's no actual camera device — showing "Take
  // photo" there would just be a confusing duplicate of "Choose photo".
  const showCameraOption = !(
    Platform.OS === 'web' &&
    typeof navigator !== 'undefined' &&
    !navigator.mediaDevices
  );

  return (
    <View style={styles.container}>
      {showCameraOption && (
        <Pressable
          style={({ pressed }) => [
            styles.optionBtn,
            pressed && !scanning && styles.optionBtnPressed,
            scanning && styles.optionBtnDisabled,
          ]}
          onPress={onTakePhoto}
          disabled={scanning}
          accessibilityRole="button"
          accessibilityLabel="Take photo"
        >
          <View style={styles.optionIcon}>
            <Ionicons name="camera-outline" size={22} color={Colors.primary} />
          </View>
          <Text style={styles.optionText}>Take photo</Text>
        </Pressable>
      )}
      <Pressable
        style={({ pressed }) => [
          styles.optionBtn,
          pressed && !scanning && styles.optionBtnPressed,
          scanning && styles.optionBtnDisabled,
        ]}
        onPress={onChoosePhoto}
        disabled={scanning}
        accessibilityRole="button"
        accessibilityLabel="Choose photo"
      >
        <View style={styles.optionIcon}>
          <Ionicons name="image-outline" size={22} color={Colors.primary} />
        </View>
        <Text style={styles.optionText}>Choose photo</Text>
      </Pressable>

      <View style={styles.statusRow}>
        {scanning ? (
          <>
            <ActivityIndicator size="small" color={Colors.primary} style={styles.statusSpinner} />
            <Text style={styles.statusText}>Reading your receipt…</Text>
          </>
        ) : (
          <Text style={styles.statusText}>Snap or upload a receipt to itemize the split.</Text>
        )}
      </View>

      <Pressable
        onPress={onSkip}
        disabled={scanning}
        accessibilityRole="button"
        accessibilityLabel="Skip, enter items manually"
      >
        <Text style={[styles.skipText, scanning && styles.skipTextDisabled]}>
          Skip — enter items manually
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: Spacing.md },
  optionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceMuted,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  optionBtnPressed: { backgroundColor: Colors.border },
  optionBtnDisabled: { opacity: 0.6 },
  optionIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Colors.primaryMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  optionText: { fontSize: 15, fontWeight: '600', color: Colors.textPrimary },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.sm,
  },
  statusSpinner: { marginRight: Spacing.sm },
  statusText: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center' },
  skipText: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.primary,
    textAlign: 'center',
    marginTop: Spacing.xs,
  },
  skipTextDisabled: { color: Colors.textTertiary },
});
