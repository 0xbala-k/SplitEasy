// mobile/components/GroupPickerSheet.tsx
import { forwardRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { SplitwiseGroup } from '@/lib/types';
import { Colors, Radius, Spacing } from '@/lib/theme';

interface Props {
  groups: SplitwiseGroup[];
  selectedGroupId: string | null;
  /** Bumped by the host on every present, so the list scrolls from the top. */
  openToken: number;
  onSelect: (group: SplitwiseGroup | null) => void;
}

/**
 * Pick (or clear) a vacation's Splitwise group. Presentational only — the
 * host owns the write and the dismiss.
 */
export const GroupPickerSheet = forwardRef<BottomSheetModal, Props>(
  ({ groups, selectedGroupId, onSelect }, ref) => {
    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['55%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
      >
        <BottomSheetFlatList
          data={groups}
          keyExtractor={(g: SplitwiseGroup) => g.id}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            <View>
              <Text style={styles.title}>Splitwise group</Text>
              {/* Linking is going-forward-only; say so rather than let the
                  user assume old expenses moved. */}
              <Text style={styles.hint}>
                New splits for this trip go into the group. Splits already created stay where
                they are in Splitwise.
              </Text>
              <Pressable
                style={[styles.row, !selectedGroupId && styles.rowSelected]}
                onPress={() => onSelect(null)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: !selectedGroupId }}
                accessibilityLabel="None"
              >
                <Text style={styles.name} numberOfLines={1}>None</Text>
                {!selectedGroupId && <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />}
              </Pressable>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={32} color={Colors.textTertiary} />
              <Text style={styles.emptyText}>No Splitwise groups found.</Text>
            </View>
          }
          renderItem={({ item }: { item: SplitwiseGroup }) => {
            const isSelected = selectedGroupId === item.id;
            return (
              <Pressable
                style={[styles.row, isSelected && styles.rowSelected]}
                onPress={() => onSelect(isSelected ? null : item)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isSelected }}
                accessibilityLabel={item.name}
              >
                <View style={styles.rowInfo}>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.members} numberOfLines={1}>
                    {item.member_ids.length} {item.member_ids.length === 1 ? 'person' : 'people'}
                  </Text>
                </View>
                {isSelected && <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />}
              </Pressable>
            );
          }}
        />
      </BottomSheetModal>
    );
  }
);

GroupPickerSheet.displayName = 'GroupPickerSheet';

const styles = StyleSheet.create({
  indicator: { backgroundColor: Colors.border, width: 36 },
  sheetBg: { backgroundColor: Colors.surface },
  content: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.xxxl },
  title: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary, marginBottom: Spacing.xs },
  hint: { fontSize: 12, color: Colors.textTertiary, marginBottom: Spacing.md, lineHeight: 17 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1,
    borderColor: Colors.border, paddingHorizontal: Spacing.md, paddingVertical: 12,
    marginBottom: Spacing.sm,
  },
  rowSelected: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  // minWidth: 0 lets a long group name truncate instead of pushing the
  // checkmark off the row on web, where a flex item's default min-width is
  // its content size, not 0.
  rowInfo: { flex: 1, minWidth: 0, marginRight: Spacing.sm },
  name: { fontSize: 15, fontWeight: '500', color: Colors.textPrimary },
  members: { fontSize: 12, color: Colors.textTertiary, marginTop: 2 },
  empty: { alignItems: 'center', paddingVertical: Spacing.xxxl, gap: Spacing.sm },
  emptyText: { fontSize: 14, color: Colors.textSecondary },
});
