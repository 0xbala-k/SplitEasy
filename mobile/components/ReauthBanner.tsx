import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface Props {
  onPress: () => void;
}

export function ReauthBanner({ onPress }: Props) {
  return (
    <View style={styles.banner}>
      <Text style={styles.text}>Your bank connection needs attention.</Text>
      <Pressable onPress={onPress} style={styles.btn}>
        <Text style={styles.btnText}>Reconnect</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#e67e22',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  text: { color: '#fff', fontSize: 13, flex: 1, marginRight: 8 },
  btn: { backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
