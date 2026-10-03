import AuthenticationServices
import PersonalShopperKit
import SwiftUI

struct SettingsView: View {
    let session: Session
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var serverURL = ""
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Server URL", text: $serverURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .onSubmit(save)
                } footer: {
                    Text("The access token is kept in the Keychain and shared with the Share extension.")
                }
                Section {
                    if session.signedIn {
                        Button("Test connection") { Task { await test() } }
                        Button("Sign out", role: .destructive) { Task { await signOut() } }
                    } else {
                        Button("Sign in with Google") { Task { await signIn() } }
                    }
                }
                if let message { Section { Text(message) } }
            }
            .navigationTitle("Settings")
            .onAppear { serverURL = session.store.serverURL }
        }
    }

    private func save() {
        session.store.serverURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func signIn() async {
        save()
        do {
            let attempt = try SignIn(serverURL: session.store.serverURL)
            let callback = try await webAuthenticationSession.authenticate(
                using: attempt.startURL, callbackURLScheme: SignIn.callbackScheme)
            try await session.store.completeSignIn(attempt, callback: callback)
            message = "Signed in."
        } catch ASWebAuthenticationSessionError.canceledLogin {
            message = nil
        } catch {
            message = error.localizedDescription
        }
        session.refresh()
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
        save()
        do {
            let count = try await session.store.client().items().count
            message = "Connected. \(count) item\(count == 1 ? "" : "s") on the server."
        } catch {
            message = error.localizedDescription
        }
        session.refresh()
    }
}
