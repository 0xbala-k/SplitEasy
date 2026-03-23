import SwiftUI

struct FriendPickerView: View {
    @StateObject private var vm: FriendPickerViewModel
    @Binding var isPresented: Bool
    let onSuccess: (String, Decimal) -> Void
    @EnvironmentObject private var newTransactionsVM: NewTransactionsViewModel


    init(transaction: Transaction, isPresented: Binding<Bool>, onSuccess: @escaping (String, Decimal) -> Void) {
        _vm = StateObject(wrappedValue: FriendPickerViewModel(transaction: transaction))
        _isPresented = isPresented
        self.onSuccess = onSuccess
    }

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading {
                    ProgressView("Loading friends…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if vm.friends.isEmpty {
                    emptyState
                } else {
                    friendList
                }
            }
            .navigationTitle(vm.transaction.merchantName ?? "Split expense")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
            }
            .safeAreaInset(edge: .bottom) { submitButton }
        }
        .task { await vm.loadFriends() }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.2.slash")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text("You have no Splitwise friends yet.\nAdd friends in Splitwise first.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
            Button("Open Splitwise") {
                UIApplication.shared.open(URL(string: "splitwise://")!)
            }
            .buttonStyle(.bordered)
        }
        .padding()
    }

    private var friendList: some View {
        List(vm.friends) { friend in
            let isSelected = vm.selectedFriends.contains(friend)
            HStack {
                VStack(alignment: .leading) {
                    Text(friend.name).font(.headline)
                    if isSelected, vm.amountPerPerson > 0 {
                        Text((Formatters.currency.string(from: vm.amountPerPerson as NSDecimalNumber) ?? "") + " each")
                            .font(.caption).foregroundColor(.accentColor)
                    }
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark.circle.fill").foregroundColor(.accentColor)
                } else {
                    Image(systemName: "circle").foregroundColor(.secondary)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { vm.toggleSelection(friend) }
        }
        .listStyle(.plain)
    }

    private var submitButton: some View {
        VStack(spacing: 0) {
            Divider()
            if let error = vm.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal)
                    .padding(.top, 8)
            }
            Button {
                Task {
                    do {
                        let result = try await vm.submit()
                        newTransactionsVM.remove(vm.transaction)
                        onSuccess(result.splitwiseExpenseId, result.amountEach)
                        isPresented = false
                    } catch {
                        print("❌ submit error: \(error)")
                        vm.errorMessage = error.localizedDescription
                    }
                }
            } label: {
                Group {
                    if vm.isSubmitting {
                        ProgressView().tint(.white)
                    } else {
                        Text("Add to Splitwise")
                    }
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(vm.canSubmit ? Color.accentColor : Color(.systemGray4))
                .foregroundColor(.white)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .disabled(!vm.canSubmit)
            .padding()
        }
        .background(Color(.systemBackground))
    }
}
