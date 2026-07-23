package dev.chatgptoauth

import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Requires that [subject] is a nonempty server-derived identifier, shared by every credential entry point. */
public fun requireSubject(subject: String) {
    require(subject.isNotBlank()) { "subject must be a nonempty server-derived identifier." }
}

/** Parses an RFC-7231 `Retry-After` header value (delay-seconds or HTTP-date) into milliseconds from [nowMs]. */
internal fun parseRetryAfterMs(raw: String?, nowMs: Long): Long? {
    raw ?: return null
    raw.toDoubleOrNull()?.takeIf(Double::isFinite)?.let { return maxOf(0L, (it * 1_000).toLong()) }
    val instant = runCatching { ZonedDateTime.parse(raw, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant() }.getOrNull()
    return instant?.toEpochMilli()?.minus(nowMs)?.coerceAtLeast(0L)
}

/**
 * Holds one subject's credential generation without exposing tokens in its string form.
 *
 * @property accessToken Bearer credential, always redacted from string output.
 * @property refreshToken Rotation credential, always redacted from string output.
 * @property idToken Optional metadata token, always redacted from string output.
 * @property expiresAt Raw epoch-millisecond expiry with no refresh margin subtracted.
 * @property accountId Unverified request-routing metadata that never authorizes.
 * @property planType Unverified display metadata that never authorizes.
 * @property email Unverified display metadata that never authorizes.
 * @property version Monotonically increasing compare-and-swap generation.
 * @property quarantinedAt Epoch-millisecond terminal-failure marker.
 * @property quarantineReason Sanitized terminal-failure reason.
 */
@Serializable
public data class TokenSet(
    public val accessToken: String,
    public val refreshToken: String,
    public val idToken: String? = null,
    public val expiresAt: Long,
    public val accountId: String? = null,
    public val planType: String? = null,
    public val email: String? = null,
    public val version: Long,
    public val quarantinedAt: Long? = null,
    public val quarantineReason: String? = null,
) {
    override fun toString(): String = "TokenSet(accessToken=[REDACTED], refreshToken=[REDACTED], " +
        "idToken=${if (idToken == null) "null" else "[REDACTED]"}, expiresAt=$expiresAt, " +
        "accountId=$accountId, planType=$planType, email=$email, version=$version, " +
        "quarantinedAt=$quarantinedAt, quarantineReason=$quarantineReason)"
}

/**
 * Reports CAS success or the current winning credential generation without clobbering it.
 *
 * @property ok Whether the supplied generation was persisted.
 * @property current Persisted generation or conflict winner, when present.
 */
public data class CompareAndSwapResult(public val ok: Boolean, public val current: TokenSet?)

/** Stores one credential generation per explicit server-derived subject. */
public interface CredentialStore {
    /** Loads credentials for the explicit subject, or null when no row exists. */
    public suspend fun load(subject: String): TokenSet?

    /** Atomically installs the next generation only when the subject version matches. */
    public suspend fun compareAndSwap(subject: String, expectedVersion: Long, next: TokenSet): CompareAndSwapResult

    /** Deletes credentials for the explicit subject. */
    public suspend fun delete(subject: String)
}

/**
 * Holds protected state needed to finish one authorization-code login with a redacted string form.
 *
 * @property url Browser authorization URL.
 * @property state Protected callback correlation value.
 * @property verifier Protected PKCE proof.
 * @property redirectUri Exact redirect URI used during exchange.
 */
public data class PendingLogin(
    public val url: String,
    public val state: String,
    public val verifier: String,
    public val redirectUri: String,
) {
    override fun toString(): String = "PendingLogin(url=[REDACTED], state=[REDACTED], verifier=[REDACTED], redirectUri=$redirectUri)"
}

/**
 * Exposes device-flow instructions and waits for exchange plus subject-scoped persistence.
 *
 * @property userCode Code displayed for user entry.
 * @property verificationUrl Fixed browser verification URL.
 * @property expiresAt Device authorization deadline in epoch milliseconds.
 */
public class DeviceLogin internal constructor(
    public val userCode: String,
    public val verificationUrl: String,
    public val expiresAt: Long,
    private val awaitTokens: suspend () -> TokenSet,
) {
    /** Waits until the device flow succeeds, expires, or fails with a typed exception. */
    public suspend fun wait(): TokenSet = awaitTokens()

    override fun toString(): String = "DeviceLogin(userCode=$userCode, verificationUrl=$verificationUrl, expiresAt=$expiresAt)"
}

/** Identifies whether a stored subject is connected or quarantined. */
public enum class SessionStatus {
    /** Indicates usable stored credentials. */
    CONNECTED,

    /** Indicates credentials blocked after terminal refresh failure. */
    QUARANTINED,
}

/**
 * Describes safe subject-bound connection metadata without exposing credentials.
 *
 * @property subject Explicit application subject owning the row.
 * @property status Connected or quarantined state.
 * @property expiresAt Raw credential expiry in epoch milliseconds.
 * @property accountId Unverified routing metadata.
 * @property planType Unverified display metadata.
 * @property email Unverified display metadata.
 * @property reason Sanitized quarantine reason.
 */
public data class Session(
    public val subject: String,
    public val status: SessionStatus,
    public val expiresAt: Long,
    public val accountId: String? = null,
    public val planType: String? = null,
    public val email: String? = null,
    public val reason: String? = null,
)

/** Represents either text or structured Responses API input. */
public sealed interface ResponseContent {
    /** Represents a plain-text Responses API input whose [value] is sent unchanged. */
    public data class Text(public val value: String) : ResponseContent

    /** Represents structured Responses API input objects held in [value]. */
    public data class Items(public val value: List<JsonObject>) : ResponseContent
}

/**
 * Describes one streaming Responses request.
 *
 * @property model Required model name.
 * @property input Text or structured input.
 * @property instructions Optional system instructions.
 * @property tools Optional tool definitions.
 * @property toolChoice Optional tool-selection JSON.
 * @property reasoning Optional reasoning configuration.
 * @property include Optional response fields to include.
 */
public data class ResponseRequest(
    public val model: String,
    public val input: ResponseContent,
    public val instructions: String? = null,
    public val tools: List<JsonObject>? = null,
    public val toolChoice: JsonElement? = null,
    public val reasoning: JsonObject? = null,
    public val include: List<String>? = null,
) {
    /** Creates a request with plain-text input. */
    public constructor(model: String, input: String, instructions: String? = null) :
        this(model, ResponseContent.Text(input), instructions)
}

/** Carries parsed SSE [type], raw [data], and an optional text [delta] while preserving unknown events. */
public data class ResponseEvent(public val type: String, public val data: JsonElement, public val delta: String? = null)

/** Collects [outputText], emitted [events], and optional completion [response] metadata. */
public data class ResponseResult(
    public val outputText: String,
    public val events: List<ResponseEvent>,
    public val response: JsonElement? = null,
)

/** Describes [usedPercent] plus optional [windowMinutes] and epoch-second [resetsAt]. */
public data class RateLimitWindow(
    public val usedPercent: Double,
    public val windowMinutes: Double? = null,
    public val resetsAt: Double? = null,
)

/** Holds optional [primary], [secondary], [planType], and [limitName] usage metadata. */
public data class RateLimitSnapshot(
    public val primary: RateLimitWindow? = null,
    public val secondary: RateLimitWindow? = null,
    public val planType: String? = null,
    public val limitName: String? = null,
)

/** Defines stable machine-readable error codes whose [value] matches the TypeScript wire name. */
public enum class ErrorCode(public val value: String) {
    /** Callback state mismatch. */
    STATE_MISMATCH("state_mismatch"),
    /** Fresh sign-in required. */
    REAUTH_REQUIRED("reauth_required"),
    /** Transient refresh failure. */
    TOKEN_REFRESH("token_refresh"),
    /** Service rate limit. */
    RATE_LIMIT("rate_limit"),
    /** Authentication rejection. */
    AUTH("auth"),
    /** External transport failure. */
    TRANSPORT("transport"),
    /** Runtime kill switch. */
    DISABLED("disabled"),
    /** Credential storage failure. */
    STORE("store"),
}

/** Base class for typed library failures whose messages never contain credentials. */
public sealed class ChatGPTOAuthException(
    public val code: ErrorCode,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

/** Reports that callback state did not match the protected pending login. */
public class StateMismatchError : ChatGPTOAuthException(ErrorCode.STATE_MISMATCH, "OAuth state did not match.")

/** Reports that [subject] must sign in again for the sanitized [reason]. */
public class ReauthRequiredError(public val subject: String, public val reason: String) : ChatGPTOAuthException(
    ErrorCode.REAUTH_REQUIRED,
    "Fresh sign-in required for subject ${subject.quote()}: ${redact(reason)}",
)

/** Reports a retryable or exhausted transient token refresh failure. */
public class TokenRefreshError(message: String = "Token refresh failed transiently.", cause: Throwable? = null) :
    ChatGPTOAuthException(ErrorCode.TOKEN_REFRESH, redact(message), cause)

/** Reports a service rate limit with optional [retryAfterMs]. */
public class RateLimitError(public val retryAfterMs: Long? = null) :
    ChatGPTOAuthException(ErrorCode.RATE_LIMIT, "The service rate limit was reached.")

/** Reports that authentication was rejected without exposing server credentials. */
public class AuthError(message: String = "Authentication was rejected.") :
    ChatGPTOAuthException(ErrorCode.AUTH, redact(message))

/** Reports a redacted transport or external-response failure. */
public class TransportError(message: String, cause: Throwable? = null) :
    ChatGPTOAuthException(ErrorCode.TRANSPORT, redact(message), cause)

/** Reports that the runtime subscription kill switch is active. */
public class DisabledError : ChatGPTOAuthException(ErrorCode.DISABLED, "ChatGPT subscription access is disabled.")

/** Reports an encrypted-storage or atomic-custody failure. */
public class StoreError(message: String, cause: Throwable? = null) :
    ChatGPTOAuthException(ErrorCode.STORE, redact(message), cause)

private fun String.quote(): String = buildString {
    append('"')
    this@quote.forEach { character ->
        when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            else -> append(character)
        }
    }
    append('"')
}
