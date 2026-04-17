import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export function OfflineBanner() {
  return (
    <View style={styles.banner}>
      <Text style={styles.text}>No internet connection</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#c0392b',
    paddingVertical: 8,
    alignItems: 'center',
  },
  text: { color: '#fff', fontSize: 13 },
});
