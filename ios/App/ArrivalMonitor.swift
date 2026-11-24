import CoreLocation
import PersonalShopperKit
import UIKit

/// Waits for the device to reach a pickup store, found by geocoding its address,
/// with a `CLMonitor` geofence that iOS watches in the background once Always
/// location access is allowed. Coordinates are never logged.
@MainActor
final class ArrivalMonitor {
    private static let radius: CLLocationDistance = 150
    /// How far from the en-route location the store's address is searched for.
    private static let searchRadius: CLLocationDistance = 100_000

    private var monitor: Task<CLMonitor, Never>?
    private var pending: (identifier: String, continuation: CheckedContinuation<Void, any Error>)?

    /// Returns once the device is within `radius` of `store`, searching for its
    /// address near `near`. Cancelling the task stops watching.
    func arrival(at store: PickupStore, near: Coordinates) async throws {
        let center = try await locate(store, near: near)
        try Task.checkCancellation()
        let monitor = await monitor()
        let identifier = UUID().uuidString
        let session = CLServiceSession(authorization: .always)
        defer {
            session.invalidate()
            Task { await monitor.remove(identifier) }
        }
        await monitor.add(
            CLMonitor.CircularGeographicCondition(center: center, radius: Self.radius),
            identifier: identifier, assuming: .unsatisfied)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending?.continuation.resume(throwing: CancellationError())
                pending = (identifier, continuation)
            }
        } onCancel: {
            Task { @MainActor in self.resume(identifier, with: .failure(CancellationError())) }
        }
    }

    private func locate(_ store: PickupStore, near: Coordinates) async throws -> CLLocationCoordinate2D {
        let region = CLCircularRegion(
            center: CLLocationCoordinate2D(latitude: near.latitude, longitude: near.longitude),
            radius: Self.searchRadius, identifier: "search")
        let placemarks = try? await CLGeocoder().geocodeAddressString(
            "\(store.address), Australia", in: region, preferredLocale: Locale(identifier: "en_AU"))
        guard let coordinate = placemarks?.first?.location?.coordinate else { throw LocationError.storeNotFound }
        return coordinate
    }

    /// The app's one monitor, created on first use; conditions left by an earlier
    /// launch are removed, since the link they were for is gone.
    private func monitor() async -> CLMonitor {
        if let monitor { return await monitor.value }
        let task = Task { [weak self] in
            let monitor = await CLMonitor("pickup-arrival")
            for identifier in await monitor.identifiers { await monitor.remove(identifier) }
            self?.listen(to: monitor)
            return monitor
        }
        monitor = task
        return await task.value
    }

    private func listen(to monitor: CLMonitor) {
        Task { [weak self] in
            do {
                for try await event in await monitor.events where event.state == .satisfied {
                    self?.arrived(event.identifier)
                }
            } catch {}
        }
    }

    /// Resumes the watch for `identifier`, keeping the app running long enough to report the arrival.
    private func arrived(_ identifier: String) {
        guard pending?.identifier == identifier else { return }
        var task = UIBackgroundTaskIdentifier.invalid
        let end = {
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
        task = UIApplication.shared.beginBackgroundTask(withName: "pickup-arrival") { end() }
        Task {
            try? await Task.sleep(for: .seconds(25))
            if task != .invalid { end() }
        }
        resume(identifier, with: .success(()))
    }

    private func resume(_ identifier: String, with result: Result<Void, any Error>) {
        guard let pending, pending.identifier == identifier else { return }
        self.pending = nil
        pending.continuation.resume(with: result)
    }
}
