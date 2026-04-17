// mobile/app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';
import { useEffect } from 'react';
import { useTransactionStore } from '@/stores/transactionStore';
import { useFriendStore } from '@/stores/friendStore';
import { pruneOldTransactions } from '@/lib/db';

export default function TabsLayout() {
  const count = useTransactionStore((s) => s.transactions.length);
  const loadFriends = useFriendStore((s) => s.load);

  useEffect(() => {
    loadFriends();
    pruneOldTransactions().catch(console.error);
  }, []);

  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'New',
          tabBarBadge: count > 0 ? count : undefined,
        }}
      />
      <Tabs.Screen name="history" options={{ title: 'History' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
