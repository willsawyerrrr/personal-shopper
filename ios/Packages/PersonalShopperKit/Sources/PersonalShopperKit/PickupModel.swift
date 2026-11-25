import Foundation
import Observation

/// State behind the pickup screen: the ready-order link, telling Woolworths the
/// customer is on their way or has parked, and the status it answers with. After
/// telling Woolworths the customer is on their way to a store it names, the model
/// waits for them to reach it and then reports their arrival. Locations are held
/// in memory only, the link also in `memory` when given; neither is logged.
@MainActor
@Observable
public final class PickupModel {
    public enum Phase: Equatable {
        case idle
        case locating
        case sending
        case failed(String)
    }

    public var link = ""
    public private(set) var phase = Phase.idle
    public private(set) var status: PickupStatus?
    /// The store the model is waiting for the customer to reach.
    public private(set) var watchedStore: PickupStore?

    private let makeClient: @MainActor () throws -> AdminClient
    private let locate: @MainActor () async throws -> Coordinates
    private let waitForArrival: @MainActor (PickupStore, Coordinates) async throws -> Void
    private let memory: PickupLinkStore?
    private var watch: Task<Void, Never>?

    /// `locate` returns the device's current location, or throws a `LocalizedError`.
    /// `waitForArrival` returns once the device reaches the store, given a location
    /// near it, or throws a `LocalizedError`; it stops watching when its task is cancelled.
    /// `memory`, when given, keeps each link used for Siri and Shortcuts.
    public init(
        makeClient: @escaping @MainActor () throws -> AdminClient,
        locate: @escaping @MainActor () async throws -> Coordinates,
        waitForArrival: @escaping @MainActor (PickupStore, Coordinates) async throws -> Void,
        memory: PickupLinkStore? = nil
    ) {
        self.makeClient = makeClient
        self.locate = locate
        self.waitForArrival = waitForArrival
        self.memory = memory
    }

    /// The pickup link in `link`, or `nil` when it holds none.
    public var parsedLink: String? { PickupLink.parse(link) }

    public var busy: Bool { phase == .locating || phase == .sending }

    /// Sets `link` from `text` (a paste or the clipboard) when it holds a pickup
    /// link, and returns whether it did.
    @discardableResult
    public func adopt(_ text: String) -> Bool {
        guard let parsed = PickupLink.parse(text) else { return false }
        stopWatching()
        link = parsed
        try? memory?.remember(parsed)
        status = nil
        dismissFailure()
        return true
    }

    /// Sends the link and the current location to the server, then watches for
    /// arrival at the store it names.
    public func enRoute() async {
        guard let link = validLink() else { return }
        phase = .locating
        let coordinates: Coordinates
        do {
            coordinates = try await locate()
        } catch {
            phase = .failed(error.localizedDescription)
            return
        }
        stopWatching()
        await send { try await $0.pickupEnRoute(link: link, coordinates: coordinates) }
        if case .idle = phase, let store = status?.store { watch(store, near: coordinates, link: link) }
    }

    public func arrived() async {
        guard let link = validLink() else { return }
        stopWatching()
        await send { try await $0.pickupArrived(link: link) }
    }

    /// Stops waiting for the customer to reach the store.
    public func stopWatching() {
        watch?.cancel()
        watch = nil
        watchedStore = nil
    }

    private func watch(_ store: PickupStore, near: Coordinates, link: String) {
        watchedStore = store
        watch = Task { [weak self, waitForArrival] in
            do {
                try await waitForArrival(store, near)
            } catch {
                guard !Task.isCancelled, let self else { return }
                watchedStore = nil
                phase = .failed(error.localizedDescription)
                return
            }
            guard !Task.isCancelled, let self else { return }
            watchedStore = nil
            await send { try await $0.pickupArrived(link: link) }
        }
    }

    public func dismissFailure() {
        if case .failed = phase { phase = .idle }
    }

    private func validLink() -> String? {
        guard let parsed = parsedLink else {
            phase = .failed(AdminError.invalidPickupLink.localizedDescription)
            return nil
        }
        try? memory?.remember(parsed)
        return parsed
    }

    private func send(_ call: (AdminClient) async throws -> PickupStatus) async {
        phase = .sending
        do {
            status = try await call(try makeClient())
            phase = .idle
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}
