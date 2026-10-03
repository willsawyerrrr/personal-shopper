import Foundation
import Synchronization
import Testing

@testable import PersonalShopperKit

final class StubURLProtocol: URLProtocol {
    typealias Handler = @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    static let handler = Mutex<Handler?>(nil)
    static let requests = Mutex<[URLRequest]>([])

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        // URLSession moves the body into a stream; keep it readable for assertions.
        var request = self.request
        if request.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            request.httpBody = data
        }
        Self.requests.withLock { $0.append(request) }
        do {
            let (response, data) = try Self.handler.withLock { $0 }!(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    static func stub(status: Int = 200, body: String = "", error: (any Error)? = nil) {
        requests.withLock { $0 = [] }
        handler.withLock {
            $0 = { request in
                if let error { throw error }
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
                return (response, Data(body.utf8))
            }
        }
    }
}

@Suite(.serialized)
struct AdminClientTests {
    let client: AdminClient

    init() throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        client = try AdminClient(
            serverURL: "https://example.test/", secret: "s3cret", session: URLSession(configuration: configuration))
    }

    @Test func listsItems() async throws {
        StubURLProtocol.stub(body: #"{"items":[{"word":"milk","stockcode":1,"quantity":2,"name":"Milk"},{"word":"eggs","stockcode":3,"quantity":1}]}"#)
        let items = try await client.items()
        #expect(items == [Item(word: "milk", stockcode: 1, quantity: 2, name: "Milk"), Item(word: "eggs", stockcode: 3, quantity: 1)])
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "GET")
        #expect(request.url?.absoluteString == "https://example.test/admin/items")
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Basic " + Data("admin:s3cret".utf8).base64EncodedString())
    }

    @Test func addsItem() async throws {
        StubURLProtocol.stub(status: 201, body: #"{"word":"milk","stockcode":888137,"quantity":2,"name":"Milk"}"#)
        let url = try #require(URL(string: "https://www.woolworths.com.au/shop/productdetails/888137/milk"))
        let item = try await client.add(word: "milk", url: url, name: "Milk", quantity: 2)
        #expect(item.stockcode == 888137)
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/admin/items")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: Any]
        #expect(body?["word"] as? String == "milk")
        #expect(body?["url"] as? String == url.absoluteString)
        #expect(body?["quantity"] as? Int == 2)
    }

    @Test func removesItemWithEncodedWord() async throws {
        StubURLProtocol.stub(status: 204)
        try await client.remove(word: "ice cream/2")
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://example.test/admin/items/ice%20cream%2F2/delete")
    }

    @Test func mapsUnauthorized() async {
        StubURLProtocol.stub(status: 401, body: #"{"error":"unauthorized"}"#)
        await #expect(throws: AdminError.unauthorized) { try await client.items() }
    }

    @Test func surfacesServerRejectionMessage() async throws {
        StubURLProtocol.stub(status: 400, body: #"{"error":"A trigger word is required."}"#)
        let url = try #require(URL(string: "https://www.woolworths.com.au/shop/productdetails/1/x"))
        await #expect(throws: AdminError.rejected("A trigger word is required.")) {
            try await client.add(word: "", url: url, name: nil, quantity: 1)
        }
    }

    @Test func mapsServerErrorAndBadBody() async {
        StubURLProtocol.stub(status: 500)
        await #expect(throws: AdminError.server(status: 500)) { try await client.items() }
        StubURLProtocol.stub(body: "<html>")
        await #expect(throws: AdminError.badResponse) { try await client.items() }
    }

    @Test func mapsNetworkFailureToOffline() async {
        StubURLProtocol.stub(error: URLError(.notConnectedToInternet))
        await #expect(throws: AdminError.offline) { try await client.items() }
    }

    @Test func rejectsInvalidServerURL() {
        #expect(throws: AdminError.invalidURL) { try AdminClient(serverURL: "not a url", secret: "x") }
        #expect(throws: AdminError.invalidURL) { try AdminClient(serverURL: "ftp://example.test", secret: "x") }
    }
}

struct SettingsStoreTests {
    final class MemorySecrets: SecretStore {
        let value = Mutex<String?>(nil)
        func read() throws -> String? { value.withLock { $0 } }
        func write(_ secret: String?) throws { value.withLock { $0 = secret } }
    }

    func store() -> SettingsStore {
        SettingsStore(defaults: UserDefaults(suiteName: UUID().uuidString)!, secrets: MemorySecrets())
    }

    @Test func defaultsToProductionServer() {
        #expect(store().serverURL == "https://personal-shopper.willsawyerrrr.dev")
    }

    @Test func requiresSecret() throws {
        #expect(throws: AdminError.notConfigured) { try store().client() }
        let configured = store()
        try configured.setSecret("  s3cret \n")
        #expect(try configured.secret() == "s3cret")
        _ = try configured.client()
    }
}
