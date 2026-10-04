import Foundation

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

    /// Adds or replaces the item for `word` and returns the stored item.
    @discardableResult
    public func add(word: String, url: URL, quantity: Int) async throws -> Item {
        struct Body: Encodable {
            let word: String
            let url: String
            let quantity: Int
        }
        let body = Body(word: word, url: url.absoluteString, quantity: quantity)
        let data = try await send("POST", path: "/items", body: JSONEncoder().encode(body))
        return try decode(Item.self, from: data)
    }

    /// Changes the item for `word` and returns the stored item. Only the
    /// arguments given change: `newWord` renames the trigger phrase, `product`
    /// is a product URL or stockcode.
    @discardableResult
    public func update(
        word: String, newWord: String? = nil, product: String? = nil, quantity: Int? = nil
    ) async throws -> Item {
        struct Body: Encodable {
            let word: String?
            let url: String?
            let quantity: Int?
        }
        let encoded = word.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? word
        let body = Body(word: newWord, url: product, quantity: quantity)
        let data = try await send("PATCH", path: "/items/\(encoded)", body: JSONEncoder().encode(body))
        return try decode(Item.self, from: data)
    }

    public func remove(word: String) async throws {
        let encoded = word.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? word
        _ = try await send("POST", path: "/items/\(encoded)/delete")
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
