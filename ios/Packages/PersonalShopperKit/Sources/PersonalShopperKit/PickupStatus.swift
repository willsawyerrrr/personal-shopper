/// An order's pickup status as Woolworths reports it after a pickup call.
public struct PickupStatus: Decodable, Equatable, Sendable {
    public let statusTitle: String
    public let statusDescription: String
    public let collectionMethod: String
    /// The store the order is collected from, when Woolworths names its address.
    public let store: PickupStore?

    public init(
        statusTitle: String, statusDescription: String, collectionMethod: String, store: PickupStore? = nil
    ) {
        self.statusTitle = statusTitle
        self.statusDescription = statusDescription
        self.collectionMethod = collectionMethod
        self.store = store
    }
}

/// A pickup store as Woolworths describes it, without coordinates.
public struct PickupStore: Decodable, Equatable, Sendable {
    public let name: String
    public let address: String

    public init(name: String, address: String) {
        self.name = name
        self.address = address
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
