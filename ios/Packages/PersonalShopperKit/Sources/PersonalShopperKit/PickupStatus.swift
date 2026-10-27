/// An order's pickup status as Woolworths reports it after a pickup call.
public struct PickupStatus: Decodable, Equatable, Sendable {
    public let statusTitle: String
    public let statusDescription: String
    public let collectionMethod: String

    public init(statusTitle: String, statusDescription: String, collectionMethod: String) {
        self.statusTitle = statusTitle
        self.statusDescription = statusDescription
        self.collectionMethod = collectionMethod
    }
}

/// A device location, in degrees.
public struct Coordinates: Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }
}
