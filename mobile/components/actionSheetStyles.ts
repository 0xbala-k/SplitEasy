// mobile/components/actionSheetStyles.ts
//
// Shared StyleSheet for ReviewActionSheet and HistoryActionSheet: the two are
// structural twins (see each component's own comment), and every one of these
// rules was previously duplicated verbatim between them. Keep it that way —
// only add a rule here if both components use the exact same values; anything
// that diverges belongs back in the component's own StyleSheet.
import { StyleSheet } from 'react-native';
import { Colors, Radius, Spacing } from '@/lib/theme';

export const actionSheetStyles = StyleSheet.create({
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
  subtext: { fontSize: 14, color: Colors.textSecondary, marginTop: 2 },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.md,
    borderRadius: Radius.md, backgroundColor: Colors.surfaceMuted, marginBottom: Spacing.sm,
  },
  actionPressed: { backgroundColor: Colors.border },
  actionText: { fontSize: 16, fontWeight: '600', color: Colors.textPrimary },
  destructiveText: { color: Colors.error },
});
