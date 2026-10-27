import SwiftUI

@main
struct PersonalShopperApp: App {
    @State private var session = Session()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if session.signedIn {
                    TabView {
                        Tab("Items", systemImage: "list.bullet") { ItemsView(session: session) }
                        Tab("Pickup", systemImage: "car") { PickupView(session: session) }
                        Tab("Settings", systemImage: "gearshape") { SettingsView(session: session) }
                    }
                } else {
                    SignInView(session: session)
                }
            }
            .onChange(of: scenePhase) { if scenePhase == .active { session.refresh() } }
        }
    }
}
