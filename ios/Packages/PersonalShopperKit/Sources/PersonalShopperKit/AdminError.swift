import Foundation

public enum AdminError: Error, Equatable, LocalizedError {
    case notSignedIn
    case invalidURL
    case unauthorized
    case offline
    case rejected(String)
    case notFound(String)
    case woolworthsSessionExpired
    case signInFailed(String)
    case server(status: Int)
    case badResponse

    public var errorDescription: String? {
        switch self {
        case .notSignedIn: "Open Personal Shopper to sign in."
        case .invalidURL: "The server URL is not valid."
        case .unauthorized: "Your sign-in expired. Open Personal Shopper to sign in again."
        case .offline: "Can't reach the server. Check your connection and the server URL."
        case .rejected(let message), .notFound(let message), .signInFailed(let message): message
        case .woolworthsSessionExpired: "The server's Woolworths session has expired. Refresh it on the server."
        case .server(let status): "The server returned an error (\(status))."
        case .badResponse: "The server sent a response the app doesn't understand."
        }
    }
}
