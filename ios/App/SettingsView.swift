import PersonalShopperKit
import SwiftUI

struct SettingsView: View {
    private let store = SettingsStore()
    @State private var serverURL = ""
    @State private var secret = ""
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Server URL", text: $serverURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    SecureField("Shared secret", text: $secret)
                } footer: {
                    Text("The secret is kept in the Keychain and shared with the Share extension.")
                }
                Section {
                    Button("Save", action: save)
                    Button("Test connection") { Task { await test() } }
                }
                if let message { Section { Text(message) } }
            }
            .navigationTitle("Settings")
            .onAppear {
                serverURL = store.serverURL
                secret = (try? store.secret()) ?? ""
            }
        }
    }

    private func save() {
        do {
            store.serverURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            try store.setSecret(secret)
            message = "Saved."
        } catch {
            message = error.localizedDescription
        }
    }

    private func test() async {
        save()
        do {
            let count = try await store.client().items().count
            message = "Connected. \(count) item\(count == 1 ? "" : "s") on the server."
        } catch {
            message = error.localizedDescription
        }
    }
}
