package dev.chatgptoauth

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * Holds protected PKCE material for one short-lived authorization attempt.
 *
 * @property verifier Secret proof retained until code exchange.
 * @property challenge Public S256 digest sent to authorization.
 * @property state Secret callback correlation value.
 */
internal data class PkceData(
    val verifier: String,
    val challenge: String,
    val state: String,
) {
    override fun toString(): String = "PkceData(verifier=[REDACTED], challenge=$challenge, state=[REDACTED])"
}

/** Encodes bytes as RFC 4648 URL-safe Base64 without padding. */
internal fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

/** Decodes RFC 4648 URL-safe Base64 with omitted padding accepted. */
internal fun decodeBase64Url(value: String): ByteArray = Base64.getUrlDecoder().decode(value)

/** Computes the S256 PKCE challenge for a verifier. */
internal fun pkceChallenge(verifier: String): String = base64Url(
    MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(StandardCharsets.UTF_8)),
)

/** Generates a fresh verifier, challenge, and state with a cryptographic RNG. */
internal fun createPkce(random: SecureRandom = SecureRandom()): PkceData {
    val verifierBytes = ByteArray(64).also(random::nextBytes)
    val stateBytes = ByteArray(32).also(random::nextBytes)
    val verifier = base64Url(verifierBytes)
    return PkceData(verifier, pkceChallenge(verifier), base64Url(stateBytes))
}

/** Validates callback state without a data-dependent early exit. */
internal fun assertState(expected: String, actual: String?) {
    val left = expected.toByteArray(StandardCharsets.UTF_8)
    val right = (actual ?: "").toByteArray(StandardCharsets.UTF_8)
    var difference = left.size xor right.size
    repeat(maxOf(left.size, right.size)) { index ->
        difference = difference or ((left.getOrElse(index) { 0 }).toInt() xor (right.getOrElse(index) { 0 }).toInt())
    }
    if (difference != 0) throw StateMismatchError()
}
