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
            serverURL: "https://example.test/", token: "ps_tok", session: URLSession(configuration: configuration))
    }

    @Test func listsItems() async throws {
        StubURLProtocol.stub(
            body: #"{"items":[{"id":"1","words":["milk"],"candidates":[{"stockcode":1,"quantity":2}],"listing":"Maleny Dairies Full Cream 2L"},{"id":"2","words":["eggs"],"candidates":[{"stockcode":3,"quantity":1}]}]}"#
        )
        let items = try await client.items()
        #expect(
            items == [
                Item(
                    id: "1", listing: "Maleny Dairies Full Cream 2L", words: ["milk"],
                    candidates: [ItemCandidate(stockcode: 1, quantity: 2)]),
                Item(id: "2", words: ["eggs"], candidates: [ItemCandidate(stockcode: 3, quantity: 1)]),
            ])
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "GET")
        #expect(request.url?.absoluteString == "https://example.test/items")
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ps_tok")
    }

    @Test func decodesItemsWithSeveralWordsAndCandidates() async throws {
        StubURLProtocol.stub(
            body: #"{"items":[{"id":"1","words":["bars","protein bars"],"candidates":[{"stockcode":1,"quantity":1},{"stockcode":2,"quantity":4}]}]}"#
        )
        let items = try await client.items()
        #expect(
            items == [
                Item(
                    id: "1", words: ["bars", "protein bars"],
                    candidates: [ItemCandidate(stockcode: 1, quantity: 1), ItemCandidate(stockcode: 2, quantity: 4)]),
            ])
    }
    @Test func listsHouseholdMembers() async throws {
        StubURLProtocol.stub(body: #"{"members":[{"email":"a@example.com","you":true},{"email":"b@example.com","you":false}]}"#)
        let members = try await client.household()
        #expect(members == [HouseholdMember(email: "a@example.com", you: true), HouseholdMember(email: "b@example.com", you: false)])
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "GET")
        #expect(request.url?.absoluteString == "https://example.test/household")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ps_tok")
    }

    @Test func createsInvite() async throws {
        StubURLProtocol.stub(status: 201, body: #"{"code":"abc123","expiresAt":1700000000000}"#)
        let invite = try await client.createInvite()
        #expect(invite == HouseholdInvite(code: "abc123", expiresAt: Date(timeIntervalSince1970: 1_700_000_000)))
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://example.test/household/invites")
    }

    @Test func reportsTheInviteLimit() async throws {
        StubURLProtocol.stub(status: 409, body: #"{"error":"Your household can have at most 5 unexpired invites."}"#)
        await #expect(throws: AdminError.rejected("Your household can have at most 5 unexpired invites.")) {
            try await client.createInvite()
        }
    }

    @Test func joinsHousehold() async throws {
        StubURLProtocol.stub(status: 204)
        try await client.joinHousehold(code: "abc123")
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://example.test/household/join")
        #expect(try #require(request.httpBody) == Data(#"{"code":"abc123"}"#.utf8))
    }

    @Test func reportsAnInvalidInviteCode() async throws {
        StubURLProtocol.stub(status: 400, body: #"{"error":"That invite code is invalid, expired or already used."}"#)
        await #expect(throws: AdminError.rejected("That invite code is invalid, expired or already used.")) {
            try await client.joinHousehold(code: "nope")
        }
    }

    @Test func leavesHousehold() async throws {
        StubURLProtocol.stub(status: 204)
        try await client.leaveHousehold()
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://example.test/household/leave")
    }

    @Test func addsItem() async throws {
        StubURLProtocol.stub(
            status: 201,
            body: #"{"id":"1","words":["milk"],"candidates":[{"stockcode":888137,"quantity":2}],"listing":"Milk 2L"}"#)
        let url = try #require(URL(string: "https://www.woolworths.com.au/shop/productdetails/888137/milk"))
        let item = try await client.add(word: "milk", url: url, quantity: 2)
        #expect(item.candidates.first?.stockcode == 888137)
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/items")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: Any]
        #expect(body?["word"] as? String == "milk")
        #expect(body?["url"] as? String == url.absoluteString)
        #expect(body?["quantity"] as? Int == 2)
    }

    @Test func removesAnItem() async throws {
        StubURLProtocol.stub(status: 204)
        try await client.remove(item())
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "DELETE")
        #expect(request.url?.absoluteString == "https://example.test/items/1")
    }

    @Test func mapsUnauthorized() async {
        StubURLProtocol.stub(status: 401, body: #"{"error":"unauthorized"}"#)
        await #expect(throws: AdminError.unauthorized) { try await client.items() }
    }

    @Test func surfacesServerRejectionMessage() async throws {
        StubURLProtocol.stub(status: 400, body: #"{"error":"A trigger word is required."}"#)
        let url = try #require(URL(string: "https://www.woolworths.com.au/shop/productdetails/1/x"))
        await #expect(throws: AdminError.rejected("A trigger word is required.")) {
            try await client.add(word: "", url: url, quantity: 1)
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
        #expect(throws: AdminError.invalidURL) { try AdminClient(serverURL: "not a url", token: "x") }
        #expect(throws: AdminError.invalidURL) { try AdminClient(serverURL: "ftp://example.test", token: "x") }
    }
}

extension AdminClientTests {
    @Test func unauthorizedRunsHandlerAndKeepsErrorMapping() async throws {
        let cleared = Mutex(false)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let client = try AdminClient(
            serverURL: "https://example.test", token: "t", session: URLSession(configuration: configuration)
        ) { cleared.withLock { $0 = true } }
        StubURLProtocol.stub(status: 401, body: #"{"error":"unauthorized"}"#)
        await #expect(throws: AdminError.unauthorized) { try await client.items() }
        #expect(cleared.withLock { $0 })
    }

    @Test func logoutPostsWithBearer() async throws {
        StubURLProtocol.stub(status: 204)
        try await client.logout()
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://example.test/auth/logout")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ps_tok")
    }

    @Test func exchangeSendsCodeAndVerifierWithoutAuthorization() async throws {
        StubURLProtocol.stub(body: #"{"access_token":"ps_new","expires_at":"2027-01-01T00:00:00Z"}"#)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let token = try await AdminClient.exchange(
            serverURL: "https://example.test", code: "c0de", verifier: "v3rifier",
            session: URLSession(configuration: configuration))
        #expect(token == "ps_new")
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.url?.absoluteString == "https://example.test/auth/token")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: String]
        #expect(body == ["code": "c0de", "code_verifier": "v3rifier"])
    }

    @Test func exchangeRejectionIsSignInFailure() async throws {
        StubURLProtocol.stub(status: 400, body: #"{"error":"invalid_grant"}"#)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        await #expect(throws: AdminError.signInFailed("Google sign-in expired. Try again.")) {
            try await AdminClient.exchange(
                serverURL: "https://example.test", code: "x", verifier: "y",
                session: URLSession(configuration: configuration))
        }
    }

    @Test func addToCartMapsSuccessToDialog() async throws {
        StubURLProtocol.stub(body: #"{"item":"milk","stockcode":888137,"quantity":2}"#)
        #expect(try await client.addToCartDialog(item: "milk") == "Added 2 × Milk")
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/cart/items")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ps_tok")
        let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: String]
        #expect(body == ["item": "milk"])
    }

    @Test func addToCartSpeaksNotFoundMessage() async throws {
        let message = #"no mapping configured for "kale""#
        StubURLProtocol.stub(status: 404, body: #"{"error":"no mapping configured for \"kale\""}"#)
        #expect(try await client.addToCartDialog(item: "kale") == message)
    }

    @Test func addToCartMapsFailures() async {
        StubURLProtocol.stub(status: 502, body: #"{"error":"session expired"}"#)
        await #expect(throws: AdminError.woolworthsSessionExpired) { try await client.addToCartDialog(item: "milk") }
        StubURLProtocol.stub(status: 401)
        await #expect(throws: AdminError.unauthorized) { try await client.addToCartDialog(item: "milk") }
    }
}

struct PKCETests {
    @Test func challengeMatchesRFC7636Vector() {
        #expect(
            PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
                == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func randomStringsAreValidVerifiers() {
        let a = PKCE.randomString()
        #expect(a.count == 43)
        #expect(a.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
        #expect(a != PKCE.randomString())
    }
}

struct SignInTests {
    func attempt() throws -> SignIn { try SignIn(serverURL: "https://example.test/", verifier: "ver", state: "st4te") }

    @Test func buildsStartURL() throws {
        let items = URLComponents(url: try attempt().startURL, resolvingAgainstBaseURL: false)
        #expect(items?.path == "/auth/start")
        let query = Dictionary(uniqueKeysWithValues: (items?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(query == [
            "client": "ios", "redirect_uri": "dev.willsawyerrrr.personal-shopper://auth",
            "code_challenge": PKCE.challenge(for: "ver"), "code_challenge_method": "S256", "state": "st4te",
        ])
    }

    @Test func acceptsMatchingState() throws {
        let url = try #require(URL(string: "dev.willsawyerrrr.personal-shopper://auth?code=abc&state=st4te"))
        #expect(try attempt().code(from: url) == "abc")
    }

    @Test func rejectsWrongStateAndServerErrors() throws {
        let wrong = try #require(URL(string: "dev.willsawyerrrr.personal-shopper://auth?code=abc&state=evil"))
        #expect(throws: AdminError.self) { try attempt().code(from: wrong) }
        let denied = try #require(URL(string: "dev.willsawyerrrr.personal-shopper://auth?error=signup_closed&state=st4te"))
        #expect(throws: AdminError.signInFailed("Sign-ups are closed.")) { try attempt().code(from: denied) }
    }
}

@Suite(.serialized)
struct SettingsStoreTests {
    final class MemoryTokens: TokenStore {
        let value = Mutex<String?>(nil)
        func read() throws -> String? { value.withLock { $0 } }
        func write(_ token: String?) throws { value.withLock { $0 = token } }
    }

    struct FailingTokens: TokenStore {
        func read() throws -> String? { throw KeychainError(status: -34018) }
        func write(_ token: String?) throws {}
    }

    func store() -> SettingsStore {
        SettingsStore(tokens: MemoryTokens())
    }

    @Test func usesProductionServer() {
        #expect(SharedConfig.serverURL == "https://personal-shopper.willsawyerrrr.dev")
    }

    @Test func requiresSignIn() throws {
        #expect(throws: AdminError.notSignedIn) { try store().client() }
        let tokens = MemoryTokens()
        let configured = SettingsStore(tokens: tokens)
        try tokens.write("ps_tok")
        #expect(configured.isSignedIn)
        _ = try configured.client()
    }

    @Test func reportsSignInState() throws {
        let tokens = MemoryTokens()
        let configured = SettingsStore(tokens: tokens)
        #expect(configured.signInState == .signedOut)
        try tokens.write("")
        #expect(configured.signInState == .signedOut)
        try tokens.write("ps_tok")
        #expect(configured.signInState == .signedIn)
    }

    @Test func reportsUnreadableKeychain() {
        let configured = SettingsStore(tokens: FailingTokens())
        guard case .unreadable = configured.signInState else {
            Issue.record("Expected .unreadable")
            return
        }
        #expect(!configured.isSignedIn)
    }

    @Test func unauthorizedClearsToken() async throws {
        let tokens = MemoryTokens()
        try tokens.write("ps_tok")
        let configured = SettingsStore(tokens: tokens)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        StubURLProtocol.stub(status: 401)
        await #expect(throws: AdminError.unauthorized) {
            try await configured.client(session: URLSession(configuration: configuration)).items()
        }
        #expect(!configured.isSignedIn)
    }
}

extension AdminClientTests {
    private func item(
        id: String = "1", words: [String] = ["milk", "full cream milk"],
        candidates: [ItemCandidate] = [ItemCandidate(stockcode: 123, quantity: 2)], listing: String? = "Milk 2L"
    ) -> Item {
        Item(id: id, listing: listing, words: words, candidates: candidates)
    }

    @Test(arguments: [
        ("milk", "Milk"), ("full cream milk", "Full Cream Milk"), ("ben & jerry's", "Ben & Jerry's"),
        ("7up", "7up"), ("coca-cola", "Coca-Cola"), ("école", "École"), ("", ""),
    ])
    func displayCasesWords(word: String, expected: String) {
        #expect(Item.displayCase(word) == expected)
    }

    @Test func rowTextShowsListingThenWordsThenDetail() {
        let one = item(
            words: ["milk", "full cream milk"], candidates: [ItemCandidate(stockcode: 248608, quantity: 2)],
            listing: "Maleny Dairies Full Cream 2L")
        #expect(one.title == "Maleny Dairies Full Cream 2L")
        #expect(one.wordsText == "Milk +1 more")
        #expect(one.detail == "248608 · qty 2")
    }

    @Test func rowTextCollapsesExtraWordsAndCandidates() {
        let many = item(
            words: ["bars", "protein bars"],
            candidates: [ItemCandidate(stockcode: 1, quantity: 1), ItemCandidate(stockcode: 2, quantity: 4)],
            listing: nil)
        #expect(many.wordsText == "Bars +1 more")
        #expect(many.detail == "1 · qty 1 +1 more")
        let single = item(words: ["milk"], candidates: [ItemCandidate(stockcode: 1, quantity: 1)], listing: nil)
        #expect(single.wordsText == "Milk")
        #expect(single.detail == "1 · qty 1")
    }

    @Test func rowTitleIsTheNameWithTheListingBeneath() {
        let named = Item(
            id: "1", name: "Milk", listing: "Maleny Dairies Full Cream 2L", words: ["milk"],
            candidates: [ItemCandidate(stockcode: 1, quantity: 1)])
        #expect(named.title == "Milk")
        #expect(named.subtitle == "Maleny Dairies Full Cream 2L")
        #expect(item(words: ["milk"]).subtitle == nil)
        let unlisted = Item(id: "1", name: "Bread", words: ["loaf"], candidates: [ItemCandidate(stockcode: 1, quantity: 1)])
        #expect(unlisted.title == "Bread")
        #expect(unlisted.subtitle == nil)
    }

    @Test func rowTitleFallsBackToTheFirstWord() {
        let unlisted = item(words: ["ben & jerry's", "ice cream"], listing: nil)
        #expect(unlisted.title == "Ben & Jerry's")
        #expect(unlisted.wordsText == "Ben & Jerry's +1 more")
    }

    private func body(of request: URLRequest) throws -> [String: Any] {
        let data = try #require(request.httpBody)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func updatesItemWithPatch() async throws {
        StubURLProtocol.stub(
            body: #"{"id":"1","words":["oat milk","oats"],"candidates":[{"stockcode":654321,"quantity":3}],"listing":"Oat 1L"}"#
        )
        let updated = try await client.update(item(), words: ["oat milk", "oats"], url: "654321", quantity: 3)
        #expect(
            updated
                == Item(
                    id: "1", listing: "Oat 1L", words: ["oat milk", "oats"],
                    candidates: [ItemCandidate(stockcode: 654321, quantity: 3)]))
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "PATCH")
        #expect(request.url?.absoluteString == "https://example.test/items/1")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ps_tok")
        let sent = try body(of: request)
        #expect(sent["words"] as? [String] == ["oat milk", "oats"])
        #expect(sent["url"] as? String == "654321")
        #expect(sent["quantity"] as? Int == 3)
    }

    @Test func updateSendsTheName() async throws {
        StubURLProtocol.stub(body: #"{"id":"1","words":["milk"],"candidates":[{"stockcode":1,"quantity":2}],"name":"Milk"}"#)
        let updated = try await client.update(item(), name: "Milk")
        #expect(updated.name == "Milk")
        let sent = try body(of: try #require(StubURLProtocol.requests.withLock { $0.first }))
        #expect(sent["name"] as? String == "Milk")
        #expect(Set(sent.keys) == ["name"])
    }

    @Test func decodesItemNames() async throws {
        StubURLProtocol.stub(body: #"{"items":[{"id":"1","words":["milk"],"candidates":[{"stockcode":1,"quantity":2}],"name":"Milk"}]}"#)
        #expect(
            try await client.items()
                == [Item(id: "1", name: "Milk", words: ["milk"], candidates: [ItemCandidate(stockcode: 1, quantity: 2)])])
    }

    @Test func updateSendsOnlyGivenFields() async throws {
        StubURLProtocol.stub(body: #"{"id":"1","words":["milk"],"candidates":[{"stockcode":1,"quantity":2}]}"#)
        try await client.update(item(), quantity: 2)
        let sent = try body(of: try #require(StubURLProtocol.requests.withLock { $0.first }))
        #expect(Set(sent.keys) == ["quantity"])
    }

    @Test func updateSendsAndClearsAlternatives() async throws {
        StubURLProtocol.stub(
            body: #"{"id":"1","words":["milk"],"candidates":[{"stockcode":1,"quantity":2},{"stockcode":9,"quantity":3}]}"#)
        let updated = try await client.update(item(), alternatives: [CandidateInput(product: "9", quantity: 3)])
        #expect(updated.candidates == [ItemCandidate(stockcode: 1, quantity: 2), ItemCandidate(stockcode: 9, quantity: 3)])
        let sent = try body(of: try #require(StubURLProtocol.requests.withLock { $0.first }))
        #expect(sent["alternatives"] as? NSArray == [["url": "9", "quantity": 3]] as NSArray)

        StubURLProtocol.stub(body: #"{"id":"1","words":["milk"],"candidates":[{"stockcode":1,"quantity":2}]}"#)
        try await client.update(item(), alternatives: [])
        let cleared = try body(of: try #require(StubURLProtocol.requests.withLock { $0.first }))
        #expect(cleared["alternatives"] as? NSArray == [] as NSArray)
    }

    @Test func updateSurfacesCollisionAndValidationMessages() async {
        StubURLProtocol.stub(status: 409, body: #"{"error":"\"bread\" is already used by another item."}"#)
        await #expect(throws: AdminError.rejected("\"bread\" is already used by another item.")) {
            try await client.update(item(), words: ["bread"])
        }
        StubURLProtocol.stub(status: 400, body: #"{"error":"The quantity must be a positive integer."}"#)
        await #expect(throws: AdminError.rejected("The quantity must be a positive integer.")) {
            try await client.update(item(), quantity: 0)
        }
        StubURLProtocol.stub(status: 404, body: #"{"error":"No such item."}"#)
        await #expect(throws: AdminError.notFound("No such item.")) {
            try await client.update(item(), quantity: 1)
        }
        StubURLProtocol.stub(status: 401)
        await #expect(throws: AdminError.unauthorized) { try await client.update(item(), quantity: 1) }
    }

    @MainActor
    private func editModel(
        _ item: Item = Item(
            id: "1", listing: "Milk 2L", words: ["milk", "full cream milk"],
            candidates: [ItemCandidate(stockcode: 123, quantity: 2)]),
        onUnauthorized: @escaping @Sendable () -> Void = {}
    ) throws -> EditItemModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let client = try AdminClient(
            serverURL: "https://example.test", token: "t", session: URLSession(configuration: configuration),
            onUnauthorized: onUnauthorized)
        return EditItemModel(item: item) { client }
    }

    @MainActor @Test func editFormStartsFromTheItem() throws {
        let model = try editModel()
        #expect(model.words == ["milk", "full cream milk"])
        #expect(model.item.listing == "Milk 2L")
        #expect(model.candidates.map(\.product) == ["123"])
        #expect(model.candidates.map(\.quantity) == [2])
        #expect(model.canSubmit)
    }

    @MainActor @Test func editFormValidatesFields() throws {
        let model = try editModel()
        model.candidates[0].product = ""
        #expect(model.candidates[0].productError == nil, "a blank product is unresolved but not yet an error")
        #expect(!model.canSubmit)
        for invalid in ["abc", "0", "-5", "https://example.com/shop/productdetails/1/x"] {
            model.candidates[0].product = invalid
            #expect(model.candidates[0].productError != nil, "\(invalid)")
            #expect(!model.canSubmit)
        }
        for valid in ["456", " 456 ", "https://www.woolworths.com.au/shop/productdetails/456/milk"] {
            model.candidates[0].product = valid
            #expect(model.candidates[0].productError == nil, "\(valid)")
            #expect(model.canSubmit)
        }
        model.candidates[0].quantity = 0
        #expect(!model.canSubmit)
        model.candidates[0].quantity = 100
        #expect(!model.canSubmit)
    }

    @MainActor @Test func editFormAddsNormalisedPhrases() throws {
        let model = try editModel()
        model.newWord = "  Skim   MILK "
        model.addWord()
        #expect(model.words == ["milk", "full cream milk", "skim milk"])
        #expect(model.newWord.isEmpty)
    }

    @MainActor @Test func editFormIgnoresDuplicateAndEmptyPhrases() throws {
        let model = try editModel()
        for phrase in [" MILK ", "Full  Cream Milk", "   "] {
            model.newWord = phrase
            model.addWord()
            #expect(model.newWord.isEmpty)
        }
        #expect(model.words == ["milk", "full cream milk"])
    }

    @MainActor @Test func editFormRemovesPhrasesButKeepsOne() throws {
        let model = try editModel()
        model.removeWords(at: [0, 1])
        #expect(model.words == ["milk", "full cream milk"])
        model.removeWords(at: [0])
        #expect(model.words == ["full cream milk"])
        model.removeWords(at: [0])
        #expect(model.words == ["full cream milk"])
        #expect(model.wordsError == nil)
        #expect(model.canSubmit)
    }

    @MainActor @Test func editFormSavesTrimmedFields() async throws {
        StubURLProtocol.stub(body: #"{"id":"1","words":["oat milk","oats"],"candidates":[{"stockcode":456,"quantity":3}]}"#)
        let model = try editModel()
        model.newWord = " Oat milk "
        model.addWord()
        model.newWord = "Oats"
        model.addWord()
        model.removeWords(at: [0, 1])
        model.candidates[0].product = "https://www.woolworths.com.au/shop/productdetails/456/oat-milk"
        model.candidates[0].quantity = 3
        await model.submit()
        #expect(model.phase == .saved)
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.url?.path == "/items/1")
        let sent = try body(of: request)
        #expect(sent["words"] as? [String] == ["oat milk", "oats"])
        #expect(sent["url"] as? String == "https://www.woolworths.com.au/shop/productdetails/456/oat-milk")
        #expect(sent["quantity"] as? Int == 3)
        #expect(sent["name"] as? String == "")
    }

    @MainActor @Test func editFormPrefillsTrimsAndValidatesTheName() async throws {
        StubURLProtocol.stub(body: #"{"id":"1","words":["milk"],"candidates":[{"stockcode":123,"quantity":2}],"name":"Milk"}"#)
        let model = try editModel(
            Item(
                id: "1", name: "Old", listing: "Milk 2L", words: ["milk"],
                candidates: [ItemCandidate(stockcode: 123, quantity: 2)]))
        #expect(model.name == "Old")
        model.name = String(repeating: "x", count: 81)
        #expect(model.nameError != nil)
        #expect(!model.canSubmit)
        model.name = "  Milk  "
        #expect(model.nameError == nil)
        await model.submit()
        let sent = try body(of: try #require(StubURLProtocol.requests.withLock { $0.first }))
        #expect(sent["name"] as? String == "Milk")
    }

    @MainActor @Test func editFormShowsServerErrorAndAllowsRetry() async throws {
        StubURLProtocol.stub(status: 409, body: #"{"error":"\"bread\" is already used by another item."}"#)
        let model = try editModel()
        model.newWord = "bread"
        model.addWord()
        await model.submit()
        #expect(model.phase == .failed("\"bread\" is already used by another item."))
        #expect(!model.signedOut)
        model.dismissFailure()
        #expect(model.phase == .editing)
    }

    @MainActor @Test func editFormReportsSignedOutOnUnauthorized() async throws {
        let cleared = Mutex(false)
        StubURLProtocol.stub(status: 401)
        let model = try editModel { cleared.withLock { $0 = true } }
        await model.submit()
        #expect(model.signedOut)
        #expect(cleared.withLock { $0 })
        #expect(model.phase == .failed(AdminError.unauthorized.localizedDescription))
    }

    @MainActor @Test func editFormDoesNotSubmitWhenInvalid() async throws {
        StubURLProtocol.stub()
        let model = try editModel()
        model.candidates[0].quantity = 0
        await model.submit()
        #expect(model.phase == .editing)
        #expect(StubURLProtocol.requests.withLock { $0.isEmpty })
    }

    @MainActor @Test func editFormPrefillsCandidatesFromTheItem() throws {
        let model = try editModel(
            Item(
                id: "1", listing: "Milk 2L", words: ["milk"],
                candidates: [ItemCandidate(stockcode: 123, quantity: 2), ItemCandidate(stockcode: 456, quantity: 1)]))
        #expect(model.candidates.map(\.product) == ["123", "456"])
        #expect(model.candidates.map(\.quantity) == [2, 1])
        #expect(model.canSubmit)
    }

    @MainActor @Test func editFormAddsEditsAndRemovesCandidates() throws {
        let model = try editModel()
        #expect(model.candidates.count == 1)
        model.addCandidate()
        let id = try #require(model.candidates.last?.id)
        #expect(model.candidates.first(where: { $0.id == id })?.productError == nil)
        #expect(!model.canSubmit)
        model.candidates[model.candidates.count - 1].product = "not a product"
        #expect(model.candidates.first(where: { $0.id == id })?.productError != nil)
        #expect(!model.canSubmit)
        model.candidates[model.candidates.count - 1].product = "789"
        model.candidates[model.candidates.count - 1].quantity = 4
        #expect(model.candidates.first(where: { $0.id == id })?.productError == nil)
        #expect(model.canSubmit)
        model.removeCandidates(at: [1])
        #expect(model.candidates.count == 1)
        #expect(model.canSubmit)
        model.removeCandidates(at: [0])
        #expect(model.candidates.count == 1, "the last candidate cannot be removed")
    }

    @MainActor @Test func editFormSavesCandidates() async throws {
        StubURLProtocol.stub(
            body: #"{"id":"1","words":["milk","full cream milk"],"candidates":[{"stockcode":123,"quantity":2},{"stockcode":789,"quantity":4}]}"#
        )
        let model = try editModel()
        model.addCandidate()
        model.candidates[1].product = "789"
        model.candidates[1].quantity = 4
        await model.submit()
        #expect(model.phase == .saved)
        let sent = try body(of: try #require(StubURLProtocol.requests.withLock { $0.first }))
        #expect(sent["alternatives"] as? NSArray == [["url": "789", "quantity": 4]] as NSArray)
    }

    private static let credential = PasskeyCredential(
        rpId: "auth.woolworths.com.au", credentialId: "Y3JlZA==", userHandle: "dXNlcg==", privateKey: "a2V5")

    @MainActor private func passkeyModel() throws -> PasskeyModel {
        let client = client
        return PasskeyModel { client }
    }

    @Test func reportsWhetherAPasskeyIsRegistered() async throws {
        StubURLProtocol.stub(body: #"{"registered":true}"#)
        #expect(try await client.passkeyRegistered())
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "GET")
        #expect(request.url?.absoluteString == "https://example.test/woolworths/passkey")
    }

    @Test func registersAPasskey() async throws {
        StubURLProtocol.stub(body: #"{"registered":true}"#)
        try await client.register(Self.credential)
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "PUT")
        #expect(request.url?.absoluteString == "https://example.test/woolworths/passkey")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ps_tok")
        let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: String]
        #expect(
            body == [
                "rpId": "auth.woolworths.com.au", "credentialId": "Y3JlZA==", "userHandle": "dXNlcg==",
                "privateKey": "a2V5",
            ])
    }

    @Test func reportsAFailedWoolworthsSignIn() async throws {
        StubURLProtocol.stub(status: 502, body: #"{"error":"passkey saved, but signing in to Woolworths with it failed: nope"}"#)
        await #expect(
            throws: AdminError.rejected("The passkey was saved, but signing in to Woolworths with it failed. Try again.")
        ) {
            try await client.register(Self.credential)
        }
    }

    @Test func removesAPasskey() async throws {
        StubURLProtocol.stub(body: #"{"registered":false}"#)
        try await client.removePasskey()
        let request = try #require(StubURLProtocol.requests.withLock { $0.first })
        #expect(request.httpMethod == "DELETE")
        #expect(request.url?.absoluteString == "https://example.test/woolworths/passkey")
    }

    @Test func readsTheCredentialTheScriptPosts() throws {
        let message: [String: Any] = [
            "rpId": "auth.woolworths.com.au", "credentialId": "Y3JlZA==", "userHandle": "dXNlcg==",
            "privateKey": "a2V5",
        ]
        #expect(PasskeyCredential(message: message) == Self.credential)
    }

    @Test func ignoresOtherMessages() {
        let good: [String: Any] = [
            "rpId": "auth.woolworths.com.au", "credentialId": "Y3JlZA==", "userHandle": "dXNlcg==",
            "privateKey": "a2V5",
        ]
        #expect(PasskeyCredential(message: good.merging(["rpId": "example.com"]) { $1 }) == nil)
        #expect(PasskeyCredential(message: good.merging(["privateKey": ""]) { $1 }) == nil)
        #expect(PasskeyCredential(message: good.filter { $0.key != "userHandle" }) == nil)
        #expect(PasskeyCredential(message: "passkey") == nil)
    }

    @Test func bundlesTheAuthenticatorScript() {
        #expect(PasskeyScript.source.contains("navigator.credentials"))
    }

    @MainActor @Test func passkeyModelLoadsRegistration() async throws {
        StubURLProtocol.stub(body: #"{"registered":true}"#)
        let model = try passkeyModel()
        #expect(model.registered == nil)
        await model.load()
        #expect(model.registered == true)
    }

    @MainActor @Test func passkeyModelRegistersTheScriptsCredential() async throws {
        StubURLProtocol.stub(body: #"{"registered":true}"#)
        let model = try passkeyModel()
        await model.register(message: ["rpId": "example.com", "credentialId": "a", "userHandle": "b", "privateKey": "c"])
        #expect(StubURLProtocol.requests.withLock { $0.isEmpty })
        await model.register(
            message: [
                "rpId": "auth.woolworths.com.au", "credentialId": "Y3JlZA==", "userHandle": "dXNlcg==",
                "privateKey": "a2V5",
            ])
        #expect(model.registered == true)
        #expect(model.phase == .idle)
        #expect(StubURLProtocol.requests.withLock { $0.count } == 1)
    }

    @MainActor @Test func passkeyModelReportsAFailedRegistration() async throws {
        StubURLProtocol.stub(status: 502)
        let model = try passkeyModel()
        await model.register(Self.credential)
        #expect(model.registered == nil)
        #expect(model.phase == .failed("The passkey was saved, but signing in to Woolworths with it failed. Try again."))
        model.dismissFailure()
        #expect(model.phase == .idle)
    }

    @MainActor @Test func passkeyModelRemovesThePasskey() async throws {
        StubURLProtocol.stub(body: #"{"registered":false}"#)
        let model = try passkeyModel()
        await model.remove()
        #expect(model.registered == false)
    }
}
