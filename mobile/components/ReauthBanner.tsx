import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius, Spacing } from '@/lib/theme';

interface Props {
  onPress: () => void;
}

export function ReauthBanner({ onPress }: Props) {
  return (
    <View style={styles.banner}>
      <Ionicons name="warning-outline" size={16} color="#7C2D12" style={styles.icon} />
      <Text style={styles.text}>Bank connection needs attention.</Text>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
        accessibilityRole="button"
        accessibilityLabel="Reconnect bank"
      >
        <Text style={styles.btnText}>Reconnect</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: Colors.warningLight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: '#FDE68A',
  },
  icon: { marginRight: Spacing.sm },
  text: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: '#7C2D12',
    marginRight: Spacing.sm,
  },
  btn: {
    backgroundColor: '#F59E0B',
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: 5,
  },
  btnPressed: { backgroundColor: '#D97706' },
  btnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
