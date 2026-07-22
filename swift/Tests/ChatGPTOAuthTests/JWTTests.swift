import Foundation
import XCTest
@testable import ChatGPTOAuth

final class JWTTests: XCTestCase {
    func testExtractsUnverifiedNamespacedClaims() throws {
        let token = try jwt([
            "email": "person@example.com",
            "https://api.openai.com/auth": [
                "chatgpt_account_id": "account-route",
                "chatgpt_plan_type": "plus",
            ],
        ])
        XCTAssertEqual(
            extractUnverifiedClaims(idToken: token),
            UnverifiedClaims(accountID: "account-route", planType: "plus", email: "person@example.com")
        )
    }

    func testPrefersValidIDTokenAndFallsBackFromMalformedIDToken() throws {
        let access = try jwt(["email": "access@example.com"])
        let id = try jwt(["email": "id@example.com"])
        XCTAssertEqual(extractUnverifiedClaims(idToken: id, accessToken: access).email, "id@example.com")
        XCTAssertEqual(extractUnverifiedClaims(idToken: "malformed", accessToken: access).email, "access@example.com")
    }

    func testClaimsNeverSupplyAStoredSubject() throws {
        let claims = extractUnverifiedClaims(accessToken: try jwt(["sub": "attacker-selected"]));
        XCTAssertEqual(claims, UnverifiedClaims())
    }

    private func jwt(_ payload: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: payload)
        return "header.\(base64URLEncode(data)).signature"
    }
}
