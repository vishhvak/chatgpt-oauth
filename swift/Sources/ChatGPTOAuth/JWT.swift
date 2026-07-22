import Foundation

/// Contains unverified JWT metadata suitable only for display and request routing, never authorization.
public struct UnverifiedClaims: Sendable, Equatable {
    /// The unverified ChatGPT account routing identifier.
    public let accountID: String?
    /// The unverified plan label for display.
    public let planType: String?
    /// The unverified email address for display.
    public let email: String?

    /// Creates a set of unverified display and routing claims.
    public init(accountID: String? = nil, planType: String? = nil, email: String? = nil) {
        self.accountID = accountID
        self.planType = planType
        self.email = email
    }
}

/// Extracts unverified display and routing claims, preferring the ID token and never authorizing from them.
public func extractUnverifiedClaims(idToken: String? = nil, accessToken: String? = nil) -> UnverifiedClaims {
    let payload = decodeJWTPayload(idToken) ?? decodeJWTPayload(accessToken) ?? [:]
    let authentication = payload["https://api.openai.com/auth"] as? [String: Any] ?? [:]
    return UnverifiedClaims(
        accountID: authentication["chatgpt_account_id"] as? String,
        planType: authentication["chatgpt_plan_type"] as? String,
        email: payload["email"] as? String
    )
}

private func decodeJWTPayload(_ token: String?) -> [String: Any]? {
    guard let token else { return nil }
    let segments = token.split(separator: ".", omittingEmptySubsequences: false)
    guard segments.count > 1,
          let data = base64URLDecode(String(segments[1])),
          let object = try? JSONSerialization.jsonObject(with: data),
          let payload = object as? [String: Any]
    else { return nil }
    return payload
}
