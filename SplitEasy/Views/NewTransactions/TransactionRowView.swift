import SwiftUI

struct TransactionRowView: View {
    let transaction: Transaction
    let onSkip: () -> Void
    let onSplit: () -> Void

    private static let currencyFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(transaction.merchantName ?? "Unknown merchant")
                        .font(.headline)
                    Text(transaction.date)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
                Text(Self.currencyFormatter.string(from: transaction.amount as NSDecimalNumber) ?? "$\(transaction.amount)")
                    .font(.headline)
            }
            HStack(spacing: 8) {
                Button(action: onSplit) {
                    Label("Split", systemImage: "person.2.fill")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                Button(action: onSkip) {
                    Label("Skip", systemImage: "xmark")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color(.systemGray5))
                        .foregroundColor(.primary)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, x: 0, y: 2)
    }
}
