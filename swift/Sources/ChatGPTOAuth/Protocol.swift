import Foundation

/// Holds the externally verified OAuth wire constants, with endpoint overrides for isolated tests.
public struct ProtocolConfiguration: Sendable, Equatable {
    /// The production protocol configuration.
    public static let production = ProtocolConfiguration()

    /// The public OAuth client identifier.
    public let clientID: String
    /// The browser authorization endpoint.
    public let authorizationURL: URL
    /// The authorization-code and refresh-token endpoint.
    public let tokenURL: URL
    /// The space-delimited OAuth scopes.
    public let scopes: String
    /// The loopback callback URL.
    public let loopbackRedirectURL: URL
    /// The device-flow user-code endpoint.
    public let deviceUserCodeURL: URL
    /// The device-flow polling endpoint.
    public let devicePollURL: URL
    /// The device-flow verification page.
    public let deviceVerificationURL: URL
    /// The redirect URI used to exchange a device authorization code.
    public let deviceRedirectURL: URL
    /// The ChatGPT Responses endpoint.
    public let responsesURL: URL
    /// The required `client_version` query value; codex backend endpoints reject requests without it.
    public let clientVersion: String
    /// The lifetime margin below which an access token is considered stale, in milliseconds.
    public let refreshMarginMilliseconds: Int64
    /// Extra fixed query parameters sent to the authorization endpoint.
    public let extraAuthorizationParameters: [String: String]

    /// Creates a complete configuration while defaulting every field to the production protocol.
    public init(
        clientID: String = "app_EMoamEEZ73f0CkXaXp7hrann",
        authorizationURL: URL = URL(string: "https://auth.openai.com/oauth/authorize")!,
        tokenURL: URL = URL(string: "https://auth.openai.com/oauth/token")!,
        scopes: String = "openid profile email offline_access",
        loopbackRedirectURL: URL = URL(string: "http://localhost:1455/auth/callback")!,
        deviceUserCodeURL: URL = URL(string: "https://auth.openai.com/api/accounts/deviceauth/usercode")!,
        devicePollURL: URL = URL(string: "https://auth.openai.com/api/accounts/deviceauth/token")!,
        deviceVerificationURL: URL = URL(string: "https://auth.openai.com/codex/device")!,
        deviceRedirectURL: URL = URL(string: "https://auth.openai.com/deviceauth/callback")!,
        responsesURL: URL = URL(string: "https://chatgpt.com/backend-api/codex/responses")!,
        clientVersion: String = "0.144.6",
        refreshMarginMilliseconds: Int64 = 120_000,
        extraAuthorizationParameters: [String: String] = [
            "id_token_add_organizations": "true",
            "codex_cli_simplified_flow": "true",
        ]
    ) {
        self.clientID = clientID
        self.authorizationURL = authorizationURL
        self.tokenURL = tokenURL
        self.scopes = scopes
        self.loopbackRedirectURL = loopbackRedirectURL
        self.deviceUserCodeURL = deviceUserCodeURL
        self.devicePollURL = devicePollURL
        self.deviceVerificationURL = deviceVerificationURL
        self.deviceRedirectURL = deviceRedirectURL
        self.responsesURL = responsesURL
        self.clientVersion = clientVersion
        self.refreshMarginMilliseconds = refreshMarginMilliseconds
        self.extraAuthorizationParameters = extraAuthorizationParameters
    }
}
