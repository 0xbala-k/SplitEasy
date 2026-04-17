import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useTransactionStore } from '@/stores/transactionStore';
import { usePlaidStore } from '@/stores/plaidStore';
import { TransactionRow } from '@/components/TransactionRow';
import { ReauthBanner } from '@/components/ReauthBanner';
import { OfflineBanner } from '@/components/OfflineBanner';
import { FriendPickerSheet } from '@/components/FriendPickerSheet';
import { useToast } from '@/components/ToastProvider';
import { Transaction } from '@/lib/types';
import { BottomSheetModal } from '@gorhom/bottom-sheet';

export default function NewTransactionsScreen() {
  const { transactions, isLoading, load, refresh, skip } = useTransactionStore();
  const needsReauth = usePlaidStore((s) => s.needs_reauth);
  const [isConnected, setIsConnected] = useState(true);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const sheetRef = useRef<BottomSheetModal>(null);
  const toast = useToast();

  useEffect(() => {
    load();
    refresh();
    const unsub = NetInfo.addEventListener((state) => setIsConnected(!!state.isConnected));
    return unsub;
  }, []);

  function openSheet(tx: Transaction) {
    setSelected(tx);
    sheetRef.current?.present();
  }

  function handleSplitSuccess(amountEach: number) {
    sheetRef.current?.dismiss();
    toast.show(`Added! Others owe you $${amountEach.toFixed(2)}`, 'success');
  }

  async function handleReauth() {
    // TODO: launch Plaid update mode
  }

  if (isLoading && transactions.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>Loading transactions…</Text>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      {needsReauth && <ReauthBanner onPress={handleReauth} />}
      {!isConnected && <OfflineBanner />}

      {transactions.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>🪣</Text>
          <Text style={styles.emptyTitle}>No new transactions</Text>
          <Text style={styles.emptySubtitle}>New transactions will appear here.</Text>
        </View>
      ) : (
        <FlatList
          data={transactions}
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refresh} />}
          renderItem={({ item }) => (
            <TransactionRow
              transaction={item}
              onSkip={() => skip(item.id)}
              onSplit={() => openSheet(item)}
            />
          )}
        />
      )}

      <FriendPickerSheet
        ref={sheetRef}
        transaction={selected}
        onSuccess={handleSplitSuccess}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#f5f5f5' },
  list: { padding: 16, gap: 12 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#111' },
  emptySubtitle: { fontSize: 14, color: '#888', marginTop: 4 },
  empty: { color: '#888' },
});
