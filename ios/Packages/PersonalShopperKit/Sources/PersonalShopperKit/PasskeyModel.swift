import Foundation
import Observation

/// State behind the Woolworths passkey screens: whether the household has a
/// passkey, and registering or removing it.
@MainActor
@Observable
public final class PasskeyModel {
    public enum Phase: Equatable {
        case idle
        case saving
        case failed(String)
    }

    /// Whether the server holds a passkey, or `nil` until it has been asked.
    public private(set) var registered: Bool?
    public private(set) var phase = Phase.idle

    private let makeClient: @MainActor () throws -> AdminClient

    public init(makeClient: @escaping @MainActor () throws -> AdminClient) {
        self.makeClient = makeClient
    }

    public func load() async {
        await run { self.registered = try await self.makeClient().passkeyRegistered() }
    }

    /// Uploads the credential the web view's script posted as `message`. Ignores
    /// anything that is not a Woolworths passkey.
    public func register(message: Any) async {
        guard let credential = PasskeyCredential(message: message) else { return }
        await register(credential)
    }

    public func register(_ credential: PasskeyCredential) async {
        phase = .saving
        await run {
            try await self.makeClient().register(credential)
            self.registered = true
        }
    }

    public func remove() async {
        await run {
            try await self.makeClient().removePasskey()
            self.registered = false
        }
    }

    public func dismissFailure() {
        if case .failed = phase { phase = .idle }
    }

    private func run(_ action: () async throws -> Void) async {
        do {
            try await action()
            phase = .idle
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}
