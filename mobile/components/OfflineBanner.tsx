import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing } from '@/lib/theme';

export function OfflineBanner() {
  return (
    <View style={styles.banner}>
      <Ionicons name="cloud-offline-outline" size={14} color={Colors.textInverse} style={styles.icon} />
      <Text style={styles.text}>No internet connection</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: Colors.textPrimary,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  icon: { marginRight: Spacing.xs },
  text: {
    color: Colors.textInverse,
    fontSize: 13,
    fontWeight: '500',
  },
});
