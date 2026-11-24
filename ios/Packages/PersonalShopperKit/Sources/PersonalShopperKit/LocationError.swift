import Foundation

public enum LocationError: Error, Equatable, LocalizedError {
    case denied
    case unavailable
    case storeNotFound

    public var errorDescription: String? {
        switch self {
        case .denied: "Location access is off. Allow it for Personal Shopper in Settings so Woolworths knows you're close."
        case .unavailable: "Couldn't find your location. Try again."
        case .storeNotFound: "Couldn't find the store on the map, so tap I've parked in a bay when you arrive."
        }
    }
}
