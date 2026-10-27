import CoreLocation
import PersonalShopperKit

/// One-shot current location, asking for when-in-use access the first time.
@MainActor
final class LocationProvider: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<Coordinates, any Error>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func current() async throws -> Coordinates {
        continuation?.resume(throwing: LocationError.unavailable)
        continuation = nil
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            switch manager.authorizationStatus {
            case .notDetermined: manager.requestWhenInUseAuthorization()
            case .authorizedWhenInUse, .authorizedAlways: manager.requestLocation()
            default: finish(.failure(LocationError.denied))
            }
        }
    }

    private func finish(_ result: Result<Coordinates, any Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            guard continuation != nil else { return }
            switch status {
            case .authorizedWhenInUse, .authorizedAlways: self.manager.requestLocation()
            case .notDetermined: break
            default: finish(.failure(LocationError.denied))
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let coordinates = Coordinates(
            latitude: location.coordinate.latitude, longitude: location.coordinate.longitude)
        Task { @MainActor in finish(.success(coordinates)) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        let denied = (error as? CLError)?.code == .denied
        Task { @MainActor in finish(.failure(denied ? LocationError.denied : LocationError.unavailable)) }
    }
}
