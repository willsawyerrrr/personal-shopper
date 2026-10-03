import Foundation

/// Client for the server's `/admin/items` JSON API, authenticated with HTTP
/// Basic auth (`admin:<shared secret>`).
public struct AdminClient: Sendable {
    private let baseURL: URL
    private let authorization: String
    private let session: URLSession

    public init(serverURL: String, secret: String, session: URLSession = .shared) throws {
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https", url.host() != nil
        else { throw AdminError.invalidURL }
        self.baseURL = url
        self.authorization = "Basic " + Data("admin:\(secret)".utf8).base64EncodedString()
        self.session = session
    }

    public func items() async throws -> [Item] {
        struct Response: Decodable { let items: [Item] }
        let data = try await send("GET", path: "items")
        return try decode(Response.self, from: data).items
    }

    /// Adds or replaces the item for `word` and returns the stored item.
    @discardableResult
    public func add(word: String, url: URL, name: String?, quantity: Int) async throws -> Item {
        struct Body: Encodable {
            let word: String
            let url: String
            let name: String?
            let quantity: Int
        }
        let body = Body(word: word, url: url.absoluteString, name: name, quantity: quantity)
        let data = try await send("POST", path: "items", body: JSONEncoder().encode(body))
        return try decode(Item.self, from: data)
    }

    public func remove(word: String) async throws {
        let encoded = word.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? word
        _ = try await send("POST", path: "items/\(encoded)/delete")
    }

    private func send(_ method: String, path: String, body: Data? = nil) async throws -> Data {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw AdminError.invalidURL
        }
        var basePath = components.percentEncodedPath
        if basePath.hasSuffix("/") { basePath.removeLast() }
        components.percentEncodedPath = basePath + "/admin/" + path
        guard let url = components.url else { throw AdminError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
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
        case 401: throw AdminError.unauthorized
        case 400:
            struct Failure: Decodable { let error: String }
            throw (try? JSONDecoder().decode(Failure.self, from: data)).map { AdminError.rejected($0.error) }
                ?? AdminError.server(status: 400)
        default: throw AdminError.server(status: http.statusCode)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { throw AdminError.badResponse }
    }
}
