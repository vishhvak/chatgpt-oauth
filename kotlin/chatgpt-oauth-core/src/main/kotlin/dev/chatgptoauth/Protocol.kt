package dev.chatgptoauth

/** Defines the production OAuth and Responses wire-protocol defaults. */
public object Protocol {
    /** Identifies the public OAuth client without a client secret. */
    public const val CLIENT_ID: String = "app_EMoamEEZ73f0CkXaXp7hrann"
    /** Receives browser authorization requests. */
    public const val AUTHORIZE_URL: String = "https://auth.openai.com/oauth/authorize"
    /** Exchanges and refreshes OAuth tokens. */
    public const val TOKEN_URL: String = "https://auth.openai.com/oauth/token"
    /** Requests identity metadata and offline refresh access. */
    public const val SCOPES: String = "openid profile email offline_access"
    /** Defines the loopback callback TCP port. */
    public const val LOOPBACK_PORT: Int = 1455
    /** Defines the exact loopback callback URL. */
    public const val LOOPBACK_REDIRECT: String = "http://localhost:1455/auth/callback"
    /** Receives streaming subscription Responses requests. */
    public const val RESPONSES_URL: String = "https://chatgpt.com/backend-api/codex/responses"

    /** Required `client_version` query value; codex backend endpoints reject requests without it. */
    public const val CLIENT_VERSION: String = "0.144.6"
    /** Starts device authorization. */
    public const val DEVICE_USERCODE_URL: String = "https://auth.openai.com/api/accounts/deviceauth/usercode"
    /** Polls device authorization state. */
    public const val DEVICE_POLL_URL: String = "https://auth.openai.com/api/accounts/deviceauth/token"
    /** Displays the device code to the user. */
    public const val DEVICE_VERIFY_URL: String = "https://auth.openai.com/codex/device"
    /** Exchanges successful device authorization codes. */
    public const val DEVICE_REDIRECT_URL: String = "https://auth.openai.com/deviceauth/callback"
    /** Defines when a token is stale without changing its raw expiry. */
    public const val REFRESH_MARGIN_MS: Long = 120_000L
    /** Enables the two fixed Codex authorization-flow parameters. */
    public val EXTRA_AUTH_PARAMS: Map<String, String> = mapOf(
        "id_token_add_organizations" to "true",
        "codex_cli_simplified_flow" to "true",
    )
}

/**
 * Configures protocol endpoints and timing while retaining production defaults.
 *
 * @property clientId Public OAuth client identifier.
 * @property authorizeUrl Browser authorization endpoint.
 * @property tokenUrl Token exchange and refresh endpoint.
 * @property scopes Space-delimited OAuth scopes.
 * @property loopbackRedirect Default JVM loopback callback URL.
 * @property responsesUrl Subscription Responses endpoint.
 * @property deviceUserCodeUrl Device-flow start endpoint.
 * @property devicePollUrl Device-flow polling endpoint.
 * @property deviceVerifyUrl User-facing device verification URL.
 * @property deviceRedirectUrl Device authorization-code exchange redirect.
 * @property refreshMarginMs Milliseconds before expiry at which a token is stale.
 * @property extraAuthParams Fixed and test-overridable authorization parameters.
 */
public data class ProtocolConfig(
    public val clientId: String = Protocol.CLIENT_ID,
    public val authorizeUrl: String = Protocol.AUTHORIZE_URL,
    public val tokenUrl: String = Protocol.TOKEN_URL,
    public val scopes: String = Protocol.SCOPES,
    public val loopbackRedirect: String = Protocol.LOOPBACK_REDIRECT,
    public val responsesUrl: String = Protocol.RESPONSES_URL,
    public val clientVersion: String = Protocol.CLIENT_VERSION,
    public val deviceUserCodeUrl: String = Protocol.DEVICE_USERCODE_URL,
    public val devicePollUrl: String = Protocol.DEVICE_POLL_URL,
    public val deviceVerifyUrl: String = Protocol.DEVICE_VERIFY_URL,
    public val deviceRedirectUrl: String = Protocol.DEVICE_REDIRECT_URL,
    public val refreshMarginMs: Long = Protocol.REFRESH_MARGIN_MS,
    public val extraAuthParams: Map<String, String> = Protocol.EXTRA_AUTH_PARAMS,
)
