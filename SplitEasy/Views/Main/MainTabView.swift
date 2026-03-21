import SwiftUI

struct MainTabView: View {
    @StateObject private var settingsVM = SettingsViewModel()
    @StateObject private var networkMonitor = NetworkMonitor.shared

    var body: some View {
        TabView {
            NewTransactionsView()
                .tabItem { Label("New", systemImage: "bell.fill") }
                .environmentObject(settingsVM)
                .environmentObject(networkMonitor)

            HistoryView()
                .tabItem { Label("History", systemImage: "clock.fill") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
        .task { await settingsVM.load() }
    }
}
