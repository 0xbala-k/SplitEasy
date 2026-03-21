import SwiftUI

struct HistoryRowView: View {
    let transaction: Transaction

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(transaction.merchantName ?? "Unknown merchant")
                    .font(.headline)
                Text(transaction.date)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(Formatters.currency.string(from: transaction.amount as NSDecimalNumber) ?? "$\(transaction.amount)")
                    .font(.headline)
                statusBadge
            }
        }
        .padding(.vertical, 4)
    }

    private var statusBadge: some View {
        Group {
            switch transaction.status {
            case .split:
                Text("Split")
                    .font(.caption)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.15))
                    .foregroundColor(.accentColor)
                    .clipShape(Capsule())
            case .skipped:
                Text("Skipped")
                    .font(.caption)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Color(.systemGray5))
                    .foregroundColor(.secondary)
                    .clipShape(Capsule())
            default:
                EmptyView()
            }
        }
    }
}
