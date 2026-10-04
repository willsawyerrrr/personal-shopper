import AuthenticationServices
import PersonalShopperKit
import SwiftUI

struct SettingsView: View {
    let session: Session
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if session.signedIn {
                        Button("Test connection") { Task { await test() } }
                        Button("Sign out", role: .destructive) { Task { await signOut() } }
                    } else {
                        Button("Sign in with Google") { Task { await signIn() } }
                    }
                } footer: {
                    Text("The access token is kept in the Keychain and shared with the Share extension.")
                }
                if let message { Section { Text(message) } }
            }
            .navigationTitle("Settings")
        }
    }

    private func signIn() async {
        do {
            let attempt = try SignIn(serverURL: SharedConfig.serverURL)
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
        do {
            let count = try await session.store.client().items().count
            message = "Connected. \(count) item\(count == 1 ? "" : "s") on the server."
        } catch {
            message = error.localizedDescription
        }
        session.refresh()
    }
}
