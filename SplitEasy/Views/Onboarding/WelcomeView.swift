import SwiftUI

struct WelcomeView: View {
    @ObservedObject var vm: OnboardingViewModel

    var body: some View {
        VStack(spacing: 32) {
            Spacer()
            Image(systemName: "dollarsign.circle.fill")
                .font(.system(size: 80))
                .foregroundStyle(.green)
            VStack(spacing: 8) {
                Text("SplitEasy")
                    .font(.largeTitle).bold()
                Text("Split expenses effortlessly")
                    .font(.title3).foregroundColor(.secondary)
            }
            Spacer()
            VStack(spacing: 12) {
                if let error = vm.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                }
                Button {
                    Task { await vm.signInWithSplitwise() }
                } label: {
                    Label("Sign in with Splitwise", systemImage: "person.crop.circle.badge.checkmark")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 48)
        }
    }
}
