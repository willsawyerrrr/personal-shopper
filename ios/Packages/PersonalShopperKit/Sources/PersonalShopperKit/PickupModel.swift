import Foundation
import Observation

/// State behind the pickup screen: the ready-order link, telling Woolworths the
/// customer is on their way or has parked, and the status it answers with. The
/// link and location are held in memory only and never logged.
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

    private let makeClient: @MainActor () throws -> AdminClient
    private let locate: @MainActor () async throws -> Coordinates

    /// `locate` returns the device's current location, or throws a `LocalizedError`.
    public init(
        makeClient: @escaping @MainActor () throws -> AdminClient,
        locate: @escaping @MainActor () async throws -> Coordinates
    ) {
        self.makeClient = makeClient
        self.locate = locate
    }

    /// The pickup link in `link`, or `nil` when it holds none.
    public var parsedLink: String? { PickupLink.parse(link) }

    public var busy: Bool { phase == .locating || phase == .sending }

    /// Sets `link` from `text` (a paste or the clipboard) when it holds a pickup
    /// link, and returns whether it did.
    @discardableResult
    public func adopt(_ text: String) -> Bool {
        guard let parsed = PickupLink.parse(text) else { return false }
        link = parsed
        status = nil
        dismissFailure()
        return true
    }

    /// Sends the link and the current location to the server.
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
        await send { try await $0.pickupEnRoute(link: link, coordinates: coordinates) }
    }

    public func arrived() async {
        guard let link = validLink() else { return }
        await send { try await $0.pickupArrived(link: link) }
    }

    public func dismissFailure() {
        if case .failed = phase { phase = .idle }
    }

    private func validLink() -> String? {
        guard let parsed = parsedLink else {
            phase = .failed(AdminError.invalidPickupLink.localizedDescription)
            return nil
        }
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
