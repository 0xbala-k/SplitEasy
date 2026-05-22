import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

type ToastStyle = 'success' | 'error';

interface ToastContextValue {
  show: (message: string, style?: ToastStyle) => void;
}

const ToastContext = createContext<ToastContextValue>({ show: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState('');
  const [style, setStyle] = useState<ToastStyle>('success');
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const show = useCallback((msg: string, s: ToastStyle = 'success') => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(msg);
    setStyle(s);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, damping: 15, stiffness: 180 }),
    ]).start();
    timer.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 12, duration: 200, useNativeDriver: true }),
      ]).start(() => setMessage(''));
    }, 2800);
  }, [opacity, translateY]);

  const icon: keyof typeof Ionicons.glyphMap =
    style === 'success' ? 'checkmark-circle-outline' : 'alert-circle-outline';

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {message ? (
        <Animated.View
          style={[styles.toast, { opacity, transform: [{ translateY }] }]}
          pointerEvents="none"
        >
          <View style={[styles.iconContainer, style === 'error' ? styles.errorIcon : styles.successIcon]}>
            <Ionicons name={icon} size={16} color={Colors.textInverse} />
          </View>
          <Text style={styles.text}>{message}</Text>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    bottom: 96,
    left: Spacing.xxl,
    right: Spacing.xxl,
    backgroundColor: Colors.textPrimary,
    borderRadius: Radius.xl,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    ...Shadow.md,
  },
  iconContainer: {
    width: 26,
    height: 26,
    borderRadius: Radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  successIcon: { backgroundColor: Colors.success },
  errorIcon: { backgroundColor: Colors.error },
  text: {
    flex: 1,
    color: Colors.textInverse,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
});
