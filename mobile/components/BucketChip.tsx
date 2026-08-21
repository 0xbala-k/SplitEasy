import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Bucket, BUCKET_LABEL } from '@/lib/buckets';
import { BucketColors, Radius } from '@/lib/theme';

interface Props {
  bucket: Bucket;
  // Vacation-bound: the bucket is Travel by definition and cannot be changed
  // here. Still pressable, so tapping can explain why.
  locked?: boolean;
  onPress?: () => void;
}

export function BucketChip({ bucket, locked, onPress }: Props) {
  const color = BucketColors[bucket];
  const label = BUCKET_LABEL[bucket];

  const body = (
    <View style={[styles.chip, { backgroundColor: `${color}1A` }]}>
      {locked && <Ionicons name="lock-closed" size={9} color={color} style={styles.lock} />}
      <Text style={[styles.text, { color }]} numberOfLines={1}>{label}</Text>
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={
        locked
          ? `Category: ${label}, set by a vacation.`
          : `Category: ${label}. Tap to change.`
      }
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 1,
    // Never let the chip absorb the row's spare width or be squeezed to
    // nothing — same reason pendingBadge in TransactionRow does this.
    flexShrink: 0,
  },
  lock: { marginRight: 3 },
  text: { fontSize: 10, fontWeight: '600' },
});
