import SwiftUI

@main
struct PersonalShopperApp: App {
    @State private var session = Session()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            TabView {
                Tab("Items", systemImage: "list.bullet") { ItemsView(session: session) }
                Tab("Settings", systemImage: "gearshape") { SettingsView(session: session) }
            }
            .onChange(of: scenePhase) { if scenePhase == .active { session.refresh() } }
        }
    }
}
