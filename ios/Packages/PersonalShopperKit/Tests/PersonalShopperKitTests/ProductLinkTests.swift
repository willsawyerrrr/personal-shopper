import Foundation
import Testing

@testable import PersonalShopperKit

struct ProductLinkTests {
    let url = "https://www.woolworths.com.au/shop/productdetails/888137/woolworths-full-cream-milk"

    @Test func parsesProductURL() throws {
        let link = try #require(ProductLink.parse(url))
        #expect(link.stockcode == 888137)
        #expect(link.slug == "woolworths-full-cream-milk")
        #expect(link.suggestedName == "Woolworths Full Cream Milk")
    }

    @Test func parsesURLWithoutSlugOrWithQuery() throws {
        let bare = try #require(ProductLink.parse("https://www.woolworths.com.au/shop/productdetails/123"))
        #expect(bare.stockcode == 123)
        #expect(bare.suggestedName == nil)
        #expect(ProductLink.parse(url + "?utm_source=share")?.stockcode == 888137)
    }

    @Test func findsURLInSharedText() throws {
        let text = "Check out Woolworths Full Cream Milk 2L \(url) on Woolworths"
        #expect(ProductLink.parse(text)?.stockcode == 888137)
    }

    @Test func acceptsSchemelessURL() {
        #expect(ProductLink.parse("www.woolworths.com.au/shop/productdetails/42/x")?.stockcode == 42)
    }

    @Test(arguments: [
        "https://example.com/shop/productdetails/123/x",
        "https://woolworths.com.au.evil.com/shop/productdetails/123/x",
        "https://www.woolworths.com.au/shop/search/products?searchTerm=milk",
        "https://www.woolworths.com.au/shop/productdetails/abc",
        "https://www.woolworths.com.au/shop/productdetails/0",
        "ftp://www.woolworths.com.au/shop/productdetails/123",
        "123456",
        "",
    ])
    func rejectsOtherInput(input: String) {
        #expect(ProductLink.parse(input) == nil)
    }
}
