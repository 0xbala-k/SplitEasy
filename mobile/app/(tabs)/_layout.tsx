import { Tabs } from 'expo-router';
import { useEffect } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTransactionStore } from '@/stores/transactionStore';
import { useFriendStore } from '@/stores/friendStore';
import { useVacationStore } from '@/stores/vacationStore';
import { pruneOldTransactions } from '@/lib/db';
import { Colors } from '@/lib/theme';

export default function TabsLayout() {
  const count = useTransactionStore((s) => s.transactions.length);
  const loadFriends = useFriendStore((s) => s.load);
  const reconcileVacations = useVacationStore((s) => s.reconcile);

  useEffect(() => {
    loadFriends();
    reconcileVacations();
    pruneOldTransactions().catch(console.error);
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.tabActive,
        tabBarInactiveTintColor: Colors.tabInactive,
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopColor: '#E2E8F0',
          borderTopWidth: 1,
          paddingTop: 6,
          paddingBottom: 4,
          height: 60,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          marginTop: 2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Transactions',
          tabBarBadge: count > 0 ? count : undefined,
          tabBarBadgeStyle: {
            backgroundColor: Colors.primary,
            fontSize: 10,
            minWidth: 18,
            height: 18,
          },
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="receipt-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="time-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
