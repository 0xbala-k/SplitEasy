import SwiftUI

@main
struct SplitEasyApp: App {
    @StateObject private var onboardingVM = OnboardingViewModel()

    var body: some Scene {
        WindowGroup {
            Group {
                switch onboardingVM.state {
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .needsSplitwiseAuth:
                    WelcomeView(vm: onboardingVM)
                case .needsBankLink:
                    BankConnectView(vm: onboardingVM)
                case .complete:
                    MainTabView()
                }
            }
            .task { await onboardingVM.checkAuthState() }
        }
    }
}
