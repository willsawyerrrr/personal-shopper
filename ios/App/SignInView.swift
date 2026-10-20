import AuthenticationServices
import PersonalShopperKit
import SwiftUI

struct SignInView: View {
    let session: Session
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var error: String?
    @State private var signingIn = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "cart")
                .font(.system(size: 64))
                .foregroundStyle(.tint)
            Text("Personal Shopper")
                .font(.largeTitle.bold())
            Spacer()
            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Button { Task { await signIn() } } label: {
                Text("Sign in with Google")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(signingIn)
        }
        .padding()
    }

    private func signIn() async {
        signingIn = true
        defer {
            signingIn = false
            session.refresh()
        }
        do {
            let attempt = try SignIn(serverURL: SharedConfig.serverURL)
            let callback = try await webAuthenticationSession.authenticate(
                using: attempt.startURL, callbackURLScheme: SignIn.callbackScheme)
            try await session.store.completeSignIn(attempt, callback: callback)
            error = nil
        } catch ASWebAuthenticationSessionError.canceledLogin {
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
