import SwiftUI

@main
struct PersonalShopperApp: App {
    var body: some Scene {
        WindowGroup {
            TabView {
                Tab("Items", systemImage: "list.bullet") { ItemsView() }
                Tab("Settings", systemImage: "gearshape") { SettingsView() }
            }
        }
    }
}
