import PersonalShopperKit
import SwiftUI

@main
struct PersonalShopperApp: App {
    @State private var session = Session()
    @State private var tab = AppTab.items
    @State private var sharedLink: String?
    @Environment(\.scenePhase) private var scenePhase

    private enum AppTab { case items, pickup, settings }

    var body: some Scene {
        WindowGroup {
            Group {
                if session.signedIn {
                    TabView(selection: $tab) {
                        Tab("Items", systemImage: "list.bullet", value: AppTab.items) { ItemsView(session: session) }
                        Tab("Pickup", systemImage: "car", value: AppTab.pickup) {
                            PickupView(session: session, sharedLink: $sharedLink)
                        }
                        Tab("Settings", systemImage: "gearshape", value: AppTab.settings) { SettingsView(session: session) }
                    }
                } else {
                    SignInView(session: session)
                }
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                session.refresh()
                guard session.signedIn, let link = try? PickupInbox().take() else { return }
                sharedLink = link
                tab = .pickup
            }
        }
    }
}
