import SwiftUI

struct ReauthBannerView: View {
    let onReconnect: () -> Void

    var body: some View {
        HStack {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Bank reconnection needed")
                    .font(.subheadline).bold()
                Text("Your bank session expired.")
                    .font(.caption).foregroundColor(.secondary)
            }
            Spacer()
            Button("Fix", action: onReconnect)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding()
        .background(Color.orange.opacity(0.1))
        .overlay(Rectangle().frame(height: 1).foregroundColor(.orange.opacity(0.3)), alignment: .bottom)
    }
}
