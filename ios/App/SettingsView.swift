import PersonalShopperKit
import SwiftUI

struct SettingsView: View {
    let session: Session
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    NavigationLink("Household") { HouseholdView(session: session) }
                    NavigationLink("Woolworths passkey") { PasskeyView(session: session) }
                    Button("Test connection") { Task { await test() } }
                    Button("Sign out", role: .destructive) { Task { await signOut() } }
                } footer: {
                    Text("The access token is kept in the Keychain and shared with the Share extension.")
                }
                if let message { Section { Text(message) } }
            }
            .navigationTitle("Settings")
        }
    }

    private func signOut() async {
        do {
            try await session.store.signOut()
            message = "Signed out."
        } catch {
            message = error.localizedDescription
        }
        session.refresh()
    }

    private func test() async {
        do {
            let count = try await session.store.client().items().count
            message = "Connected. \(count) item\(count == 1 ? "" : "s") on the server."
        } catch {
            message = error.localizedDescription
        }
        session.refresh()
    }
}
