import XCTest
@testable import ChatGPTOAuth

final class PKCETests: XCTestCase {
    func testKnownS256Vector() {
        XCTAssertEqual(
            PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        )
    }

    func testGeneratedValuesAreUnpaddedBase64URL() throws {
        let generated = try PKCE.generate()
        XCTAssertNotNil(generated.verifier.range(of: #"^[A-Za-z0-9_-]{86}$"#, options: .regularExpression))
        XCTAssertNotNil(generated.challenge.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression))
        XCTAssertNotNil(generated.state.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression))
    }

    func testStateRequiresAnExactMatch() throws {
        XCTAssertNoThrow(try PKCE.assertState(expected: "expected", actual: "expected"))
        XCTAssertThrowsError(try PKCE.assertState(expected: "expected", actual: "expectee")) { error in
            XCTAssertEqual(error as? ChatGPTOAuthError, .stateMismatch)
        }
        XCTAssertThrowsError(try PKCE.assertState(expected: "expected", actual: nil))
    }
}
