import Foundation

/// A product reference (a Woolworths product URL or a stockcode) and quantity, sent as one of
/// an item's candidate products.
public struct CandidateInput: Sendable, Equatable {
    public let product: String
    public let quantity: Int

    public init(product: String, quantity: Int) {
        self.product = product
        self.quantity = quantity
    }
}

/// Client for the server's JSON API, authenticated with a bearer token.
public struct AdminClient: Sendable {
    private let baseURL: URL
    private let authorization: String
    private let session: URLSession
    private let onUnauthorized: @Sendable () -> Void

    /// `onUnauthorized` runs when the server answers `401`, before the error is thrown.
    public init(
        serverURL: String, token: String, session: URLSession = .shared,
        onUnauthorized: @escaping @Sendable () -> Void = {}
    ) throws {
        self.baseURL = try validatedServerURL(serverURL)
        self.authorization = "Bearer " + token
        self.session = session
        self.onUnauthorized = onUnauthorized
    }

    /// Redeems a sign-in code for an access token.
    public static func exchange(
        serverURL: String, code: String, verifier: String, session: URLSession = .shared
    ) async throws -> String {
        struct Body: Encodable {
            let code: String
            let codeVerifier: String
            enum CodingKeys: String, CodingKey {
                case code
                case codeVerifier = "code_verifier"
            }
        }
        struct Response: Decodable {
            let accessToken: String
            enum CodingKeys: String, CodingKey { case accessToken = "access_token" }
        }
        let client = try AdminClient(serverURL: serverURL, token: "", session: session)
        do {
            let data = try await client.send(
                "POST", path: "/auth/token", body: JSONEncoder().encode(Body(code: code, codeVerifier: verifier)),
                authorized: false)
            return try client.decode(Response.self, from: data).accessToken
        } catch AdminError.rejected {
            throw AdminError.signInFailed("Google sign-in expired. Try again.")
        }
    }

    /// Revokes the token on the server.
    public func logout() async throws {
        _ = try await send("POST", path: "/auth/logout")
    }

    /// Adds the item mapped to the spoken term `item` to the Woolworths cart.
    public func addToCart(item: String) async throws -> CartAddition {
        struct Body: Encodable { let item: String }
        let data = try await send("POST", path: "/cart/items", body: JSONEncoder().encode(Body(item: item)))
        return try decode(CartAddition.self, from: data)
    }

    /// The sentence to speak for `addToCart(item:)`: the addition, or the
    /// server's message when no mapping exists for `item`.
    public func addToCartDialog(item: String) async throws -> String {
        do {
            return try await addToCart(item: item).dialog
        } catch AdminError.notFound(let message) {
            return message
        }
    }

    public func items() async throws -> [Item] {
        struct Response: Decodable { let items: [Item] }
        let data = try await send("GET", path: "/items")
        return try decode(Response.self, from: data).items
    }

    /// Creates an item for `word`, with `url`/`quantity` as its first candidate and `alternatives`
    /// as the rest, and returns it as stored.
    @discardableResult
    public func add(
        word: String, url: URL, quantity: Int, name: String? = nil, alternatives: [CandidateInput]? = nil
    ) async throws -> Item {
        struct CandidateBody: Encodable {
            let url: String
            let quantity: Int
        }
        struct Body: Encodable {
            let word: String
            let url: String
            let quantity: Int
            let name: String?
            let alternatives: [CandidateBody]?
        }
        let body = Body(
            word: word, url: url.absoluteString, quantity: quantity, name: name,
            alternatives: alternatives?.map { CandidateBody(url: $0.product, quantity: $0.quantity) })
        let data = try await send("POST", path: "/items", body: JSONEncoder().encode(body))
        return try decode(Item.self, from: data)
    }

    /// Changes `item` and returns it as stored. Only the arguments given change: `words`
    /// replaces the item's whole set of trigger words, `url`/`quantity` edit its first
    /// candidate, `name` the custom display name (empty clears it), `alternatives` replaces
    /// every candidate after the first wholesale (empty clears them).
    @discardableResult
    public func update(
        _ item: Item, words: [String]? = nil, url: String? = nil, quantity: Int? = nil,
        name: String? = nil, alternatives: [CandidateInput]? = nil
    ) async throws -> Item {
        struct CandidateBody: Encodable {
            let url: String
            let quantity: Int
        }
        struct Body: Encodable {
            let words: [String]?
            let url: String?
            let quantity: Int?
            let name: String?
            let alternatives: [CandidateBody]?
        }
        let body = Body(
            words: words, url: url, quantity: quantity, name: name,
            alternatives: alternatives?.map { CandidateBody(url: $0.product, quantity: $0.quantity) })
        let data = try await send("PATCH", path: "/items/\(item.id)", body: JSONEncoder().encode(body))
        return try decode(Item.self, from: data)
    }

    /// Removes `item`.
    public func remove(_ item: Item) async throws {
        _ = try await send("DELETE", path: "/items/\(item.id)")
    }

    /// The members of the signed-in user's household, the user included.
    public func household() async throws -> [HouseholdMember] {
        struct Response: Decodable { let members: [HouseholdMember] }
        let data = try await send("GET", path: "/household")
        return try decode(Response.self, from: data).members
    }

    /// Creates a single-use invite code to the signed-in user's household.
    public func createInvite() async throws -> HouseholdInvite {
        struct Response: Decodable {
            let code: String
            let expiresAt: Double
        }
        let data = try await send("POST", path: "/household/invites")
        let response = try decode(Response.self, from: data)
        return HouseholdInvite(code: response.code, expiresAt: Date(timeIntervalSince1970: response.expiresAt / 1000))
    }

    /// Moves the signed-in user into the household `code` invites to. Their
    /// previous household and its items are discarded if nobody else is in it.
    public func joinHousehold(code: String) async throws {
        struct Body: Encodable { let code: String }
        _ = try await send("POST", path: "/household/join", body: JSONEncoder().encode(Body(code: code)))
    }

    /// Moves the signed-in user into a new, empty household.
    public func leaveHousehold() async throws {
        _ = try await send("POST", path: "/household/leave")
    }

    /// Whether the server holds a Woolworths passkey for the signed-in user's household.
    public func passkeyRegistered() async throws -> Bool {
        struct Response: Decodable { let registered: Bool }
        return try decode(Response.self, from: await send("GET", path: "/woolworths/passkey")).registered
    }

    /// Stores `credential` as the household's Woolworths passkey. The server signs in
    /// with it at once, so this fails if Woolworths rejects it.
    public func register(_ credential: PasskeyCredential) async throws {
        do {
            _ = try await send("PUT", path: "/woolworths/passkey", body: JSONEncoder().encode(credential))
        } catch AdminError.woolworthsSessionExpired {
            throw AdminError.rejected("The passkey was saved, but signing in to Woolworths with it failed. Try again.")
        }
    }

    /// Removes the household's Woolworths passkey and its stored Woolworths session.
    public func removePasskey() async throws {
        _ = try await send("DELETE", path: "/woolworths/passkey")
    }

    /// Tells Woolworths the customer behind `link`, the ready-order link from the
    /// pickup SMS or email, is on their way from `coordinates`.
    public func pickupEnRoute(link: String, coordinates: Coordinates) async throws -> PickupStatus {
        struct Body: Encodable {
            let link: String
            let latitude: Double
            let longitude: Double
        }
        let body = Body(link: link, latitude: coordinates.latitude, longitude: coordinates.longitude)
        return try await pickup("/pickup/en-route", body: JSONEncoder().encode(body))
    }

    /// Tells Woolworths the customer behind `link` has parked in a bay.
    public func pickupArrived(link: String) async throws -> PickupStatus {
        struct Body: Encodable { let link: String }
        return try await pickup("/pickup/arrived", body: JSONEncoder().encode(Body(link: link)))
    }

    private func pickup(_ path: String, body: Data) async throws -> PickupStatus {
        do {
            return try decode(PickupStatus.self, from: await send("POST", path: path, body: body))
        } catch AdminError.woolworthsSessionExpired {
            throw AdminError.pickupUnavailable
        }
    }

    private func send(_ method: String, path: String, body: Data? = nil, authorized: Bool = true) async throws -> Data {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw AdminError.invalidURL
        }
        components.percentEncodedPath = trimmingTrailingSlash(components.percentEncodedPath) + path
        guard let url = components.url else { throw AdminError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authorized { request.setValue(authorization, forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw error.code == .badURL || error.code == .unsupportedURL ? AdminError.invalidURL : .offline
        }
        guard let http = response as? HTTPURLResponse else { throw AdminError.badResponse }
        switch http.statusCode {
        case 200..<300: return data
        case 401:
            if authorized { onUnauthorized() }
            throw AdminError.unauthorized
        case 422: throw AdminError.invalidPickupLink
        case 429: throw AdminError.rateLimited
        case 502: throw AdminError.woolworthsSessionExpired
        case 400, 404, 409:
            struct Failure: Decodable { let error: String }
            let message = (try? JSONDecoder().decode(Failure.self, from: data))?.error
            guard let message else { throw AdminError.server(status: http.statusCode) }
            throw http.statusCode == 404 ? AdminError.notFound(message) : .rejected(message)
        default: throw AdminError.server(status: http.statusCode)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { throw AdminError.badResponse }
    }
}
