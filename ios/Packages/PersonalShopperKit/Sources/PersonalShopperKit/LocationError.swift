import Foundation

public enum LocationError: Error, Equatable, LocalizedError {
    case denied
    case unavailable

    public var errorDescription: String? {
        switch self {
        case .denied: "Location access is off. Allow it for Personal Shopper in Settings so Woolworths knows you're close."
        case .unavailable: "Couldn't find your location. Try again."
        }
    }
}
