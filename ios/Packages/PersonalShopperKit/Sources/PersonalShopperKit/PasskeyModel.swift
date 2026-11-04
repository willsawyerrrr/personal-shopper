import Foundation
import Observation

/// State behind the Woolworths passkey screens: whether the household has a
/// passkey, registering or removing it, and whether the server can sign in
/// with it.
@MainActor
@Observable
public final class PasskeyModel {
    public enum Phase: Equatable {
        case idle
        case saving
        case failed(String)
    }

    public enum Verification: Equatable {
        case verifying
        case verified
        case failed(String)
    }

    /// Whether the server holds a passkey, or `nil` until it has been asked.
    public private(set) var registered: Bool?
    public private(set) var phase = Phase.idle
    /// Whether the server could sign in with the passkey registered in this
    /// session, or `nil` when none has been registered since the model was made.
    public private(set) var verification: Verification?

    private let makeClient: @MainActor () throws -> AdminClient
    private let verifyDelay: Duration
    private let verifyAttempts: Int
    private var verifying: Task<Void, Never>?

    /// `verifyDelay` is the wait before each sign-in attempt, giving Woolworths time to
    /// accept a new passkey; a failure is reported only after `verifyAttempts` attempts.
    public init(
        verifyDelay: Duration = .seconds(3),
        verifyAttempts: Int = 4,
        makeClient: @escaping @MainActor () throws -> AdminClient
    ) {
        self.verifyDelay = verifyDelay
        self.verifyAttempts = verifyAttempts
        self.makeClient = makeClient
    }

    public func load() async {
        await run { self.registered = try await self.makeClient().passkeyRegistered() }
    }

    /// Uploads the credential the web view's script posted as `message`. Ignores
    /// anything that is not a Woolworths passkey. Returns whether the server stored it.
    @discardableResult
    public func register(message: Any) async -> Bool {
        guard let credential = PasskeyCredential(message: message) else { return false }
        return await register(credential)
    }

    @discardableResult
    public func register(_ credential: PasskeyCredential) async -> Bool {
        phase = .saving
        return await run {
            try await self.makeClient().register(credential)
            self.registered = true
        }
    }

    /// Signs in to Woolworths with the stored passkey, after `verifyDelay` and again
    /// after each failure, and sets `verification` once it succeeds or runs out of attempts.
    public func verify() async {
        verification = .verifying
        var failure = ""
        for _ in 0..<verifyAttempts {
            try? await Task.sleep(for: verifyDelay)
            if Task.isCancelled { return }
            do {
                try await makeClient().verifyPasskey()
                verification = .verified
                return
            } catch {
                failure = error.localizedDescription
            }
        }
        verification = .failed(failure)
    }

    /// Runs `verify()` in the background, replacing a verification already running.
    public func startVerification() {
        verifying?.cancel()
        verification = .verifying
        verifying = Task { await verify() }
    }

    public func remove() async {
        await run {
            try await self.makeClient().removePasskey()
            self.verifying?.cancel()
            self.verification = nil
            self.registered = false
        }
    }

    public func dismissFailure() {
        if case .failed = phase { phase = .idle }
    }

    @discardableResult
    private func run(_ action: () async throws -> Void) async -> Bool {
        do {
            try await action()
            phase = .idle
            return true
        } catch {
            phase = .failed(error.localizedDescription)
            return false
        }
    }
}
