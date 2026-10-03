import Foundation

public enum AdminError: Error, Equatable, LocalizedError {
    case notConfigured
    case invalidURL
    case unauthorized
    case offline
    case rejected(String)
    case server(status: Int)
    case badResponse

    public var errorDescription: String? {
        switch self {
        case .notConfigured: "Set the server URL and shared secret in Settings."
        case .invalidURL: "The server URL is not valid."
        case .unauthorized: "The server rejected the shared secret."
        case .offline: "Can't reach the server. Check your connection and the server URL."
        case .rejected(let message): message
        case .server(let status): "The server returned an error (\(status))."
        case .badResponse: "The server sent a response the app doesn't understand."
        }
    }
}
