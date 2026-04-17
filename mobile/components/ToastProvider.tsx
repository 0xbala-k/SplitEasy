import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

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
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const show = useCallback((msg: string, s: ToastStyle = 'success') => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(msg);
    setStyle(s);
    Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.delay(2600),
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
    timer.current = setTimeout(() => setMessage(''), 3000);
  }, [opacity]);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {message ? (
        <Animated.View
          style={[styles.toast, style === 'error' ? styles.error : styles.success, { opacity }]}
          pointerEvents="none"
        >
          <Text style={styles.text}>{message}</Text>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    bottom: 100,
    left: 24,
    right: 24,
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  success: { backgroundColor: '#1c7c54' },
  error: { backgroundColor: '#c0392b' },
  text: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
