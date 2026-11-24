import Foundation

/// Tells Woolworths the customer is on their way or has parked, for Siri and
/// Shortcuts. The link comes from the caller, else the share extension's inbox,
/// else the last one remembered.
@MainActor
public struct PickupShortcut {
    private let makeClient: @MainActor () throws -> AdminClient
    private let locate: @MainActor () async throws -> Coordinates
    private let inbox: PickupInbox
    private let memory: PickupLinkStore

    /// `locate` returns the device's current location, or throws a `LocalizedError`.
    public init(
        makeClient: @escaping @MainActor () throws -> AdminClient,
        locate: @escaping @MainActor () async throws -> Coordinates,
        inbox: PickupInbox = PickupInbox(),
        memory: PickupLinkStore = PickupLinkStore()
    ) {
        self.makeClient = makeClient
        self.locate = locate
        self.inbox = inbox
        self.memory = memory
    }

    /// Sends the link and the current location, and returns what Siri says.
    public func enRoute(link: String?) async throws -> String {
        let link = try resolve(link)
        let coordinates = try await locate()
        let status = try await makeClient().pickupEnRoute(link: link, coordinates: coordinates)
        return dialog(status)
    }

    /// Sends the link, and returns what Siri says.
    public func arrived(link: String?) async throws -> String {
        let link = try resolve(link)
        return dialog(try await makeClient().pickupArrived(link: link))
    }

    private func resolve(_ given: String?) throws -> String {
        let trimmed = given?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let link: String
        if !trimmed.isEmpty {
            guard let parsed = PickupLink.parse(trimmed) else { throw AdminError.invalidPickupLink }
            link = parsed
        } else if let waiting = try? inbox.take() {
            link = waiting
        } else if let remembered = try? memory.recall() {
            link = remembered
        } else {
            throw AdminError.noPickupLink
        }
        try? memory.remember(link)
        return link
    }

    private func dialog(_ status: PickupStatus) -> String {
        "\(status.statusTitle). \(status.statusDescription)"
    }
}
