// mobile/components/ReceiptItemRow.tsx
//
// One editable receipt line: name, price, delete, and assignee chips. Purely
// presentational (see Task 5 brief) — no store access; every edit is reported
// to the caller via callbacks, which applies it to `items` state in
// FriendPickerSheet (Task 6). Name/price fields follow the same
// local-state + commit-on-blur pattern as `CustomRow` in FriendPickerSheet.tsx.
import { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { ReceiptItem } from '@/lib/receipt';
import { Colors, Radius, Spacing } from '@/lib/theme';

// A participant available for assignment, in display order: the owner first
// (label "You"), then each selected friend (label = display_name).
export interface ReceiptParticipant {
  id: string;
  label: string;
}

interface Props {
  item: ReceiptItem;
  participants: ReceiptParticipant[];
  onChangeName: (itemId: string, name: string) => void;
  onChangePriceCents: (itemId: string, priceCents: number) => void;
  onDelete: (itemId: string) => void;
  onChangeAssignees: (itemId: string, assignees: string[]) => void;
}

function ReceiptItemRowImpl({
  item,
  participants,
  onChangeName,
  onChangePriceCents,
  onDelete,
  onChangeAssignees,
}: Props) {
  const [nameFocused, setNameFocused] = useState(false);
  const [nameText, setNameText] = useState(item.name);
  const [priceFocused, setPriceFocused] = useState(false);
  const [priceText, setPriceText] = useState((item.priceCents / 100).toFixed(2));

  useEffect(() => {
    if (!nameFocused) setNameText(item.name);
  }, [item.name, nameFocused]);

  useEffect(() => {
    if (!priceFocused) setPriceText((item.priceCents / 100).toFixed(2));
  }, [item.priceCents, priceFocused]);

  function handleNameBlur() {
    setNameFocused(false);
    const trimmed = nameText.trim();
    if (trimmed) {
      onChangeName(item.id, trimmed);
      setNameText(trimmed);
    } else {
      // Invalid (empty) — revert to the last-committed value, same as
      // CustomRow's handling of an unparsable amount.
      setNameText(item.name);
    }
  }

  function handlePriceBlur() {
    setPriceFocused(false);
    const parsed = parseFloat(priceText);
    if (!isNaN(parsed) && parsed >= 0) {
      const rounded = Math.round(parsed * 100) / 100;
      onChangePriceCents(item.id, Math.round(rounded * 100));
      setPriceText(rounded.toFixed(2));
    } else {
      setPriceText((item.priceCents / 100).toFixed(2));
    }
  }

  const allIds = participants.map((p) => p.id);
  const isAllAssigned = allIds.length > 0 && allIds.every((id) => item.assignees.includes(id));
  const unassigned = item.assignees.length === 0;

  function toggleAll() {
    onChangeAssignees(item.id, isAllAssigned ? [] : allIds);
  }

  function toggleParticipant(id: string) {
    const next = item.assignees.includes(id)
      ? item.assignees.filter((a) => a !== id)
      : [...item.assignees, id];
    onChangeAssignees(item.id, next);
  }

  const shareEach = item.assignees.length > 0 ? item.priceCents / item.assignees.length / 100 : 0;

  return (
    <View style={[styles.container, unassigned && styles.containerUnassigned]}>
      <View style={styles.fieldsRow}>
        <BottomSheetTextInput
          style={styles.nameInput}
          value={nameText}
          onChangeText={setNameText}
          onFocus={() => setNameFocused(true)}
          onBlur={handleNameBlur}
          placeholder="Item"
          placeholderTextColor={Colors.textTertiary}
          accessibilityLabel="Item name"
        />
        <View style={styles.priceWrap}>
          <Text style={styles.priceDollar}>$</Text>
          <BottomSheetTextInput
            style={styles.priceInput}
            value={priceText}
            onChangeText={setPriceText}
            onFocus={() => setPriceFocused(true)}
            onBlur={handlePriceBlur}
            keyboardType="decimal-pad"
            selectTextOnFocus
            accessibilityLabel="Item price"
          />
        </View>
        <Pressable
          style={({ pressed }) => [styles.deleteBtn, pressed && styles.deleteBtnPressed]}
          onPress={() => onDelete(item.id)}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${item.name || 'item'}`}
        >
          <Ionicons name="trash-outline" size={18} color={Colors.error} />
        </Pressable>
      </View>

      <View style={styles.chipsRow}>
        <Pressable
          style={[styles.chip, isAllAssigned && styles.chipActive]}
          onPress={toggleAll}
          accessibilityRole="button"
          accessibilityState={{ selected: isAllAssigned }}
          accessibilityLabel="Assign to everyone"
        >
          <Text style={[styles.chipText, isAllAssigned && styles.chipTextActive]}>All</Text>
        </Pressable>
        {participants.map((p) => {
          const active = item.assignees.includes(p.id);
          return (
            <Pressable
              key={p.id}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => toggleParticipant(p.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={p.label}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                {p.label}
              </Text>
            </Pressable>
          );
        })}
        <Text style={[styles.hint, unassigned && styles.hintError]}>
          {unassigned
            ? 'Assign someone'
            : `${item.assignees.length} sharing · $${shareEach.toFixed(2)} ea`}
        </Text>
      </View>
    </View>
  );
}

// Custom comparator (rather than the default shallow-props compare) so this
// row only re-renders when its own item or the participant list changes —
// not when sibling rows' callbacks are re-created on every parent render.
function areEqual(prev: Props, next: Props): boolean {
  if (prev.item !== next.item) return false;
  if (prev.participants.length !== next.participants.length) return false;
  for (let i = 0; i < prev.participants.length; i++) {
    if (prev.participants[i].id !== next.participants[i].id) return false;
    if (prev.participants[i].label !== next.participants[i].label) return false;
  }
  return true;
}

export const ReceiptItemRow = memo(ReceiptItemRowImpl, areEqual);

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.surfaceMuted,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.xs,
  },
  containerUnassigned: { backgroundColor: Colors.errorLight },

  fieldsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  nameInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: Colors.textPrimary,
    marginRight: Spacing.sm,
    paddingVertical: 4,
  },
  priceWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    marginRight: Spacing.sm,
    minWidth: 72,
  },
  priceDollar: { fontSize: 14, color: Colors.textSecondary, fontWeight: '500' },
  priceInput: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textPrimary,
    fontVariant: ['tabular-nums'],
    minWidth: 48,
    textAlign: 'right',
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  deleteBtn: {
    width: 32,
    height: 32,
    borderRadius: Radius.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteBtnPressed: { backgroundColor: Colors.border },

  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  chip: {
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingVertical: 5,
    paddingHorizontal: Spacing.sm,
    marginRight: Spacing.xs,
    marginBottom: Spacing.xs,
    maxWidth: 120,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: Colors.textSecondary },
  chipTextActive: { color: Colors.textInverse },

  hint: {
    fontSize: 11,
    color: Colors.textTertiary,
    marginBottom: Spacing.xs,
  },
  hintError: { color: Colors.error, fontWeight: '600' },
});
