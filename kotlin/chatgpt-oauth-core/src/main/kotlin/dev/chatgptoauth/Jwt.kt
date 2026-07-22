package dev.chatgptoauth

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private const val CLAIM_NAMESPACE = "https://api.openai.com/auth"
private val lenientJson = Json { ignoreUnknownKeys = true }

/**
 * Holds JWT metadata that is unverified and never suitable for authorization.
 *
 * @property accountId Optional unverified request-routing identifier.
 * @property planType Optional unverified display plan.
 * @property email Optional unverified display email.
 */
public data class UnverifiedClaims(
    public val accountId: String? = null,
    public val planType: String? = null,
    public val email: String? = null,
)

private fun decodePayload(token: String): JsonObject? {
    val payload = token.split('.').getOrNull(1) ?: return null
    return runCatching {
        lenientJson.parseToJsonElement(decodeBase64Url(payload).toString(Charsets.UTF_8)).jsonObject
    }.getOrNull()
}

/** Extracts unverified display/routing claims; they never authorize, choose a subject, or determine row ownership. */
public fun extractUnverifiedClaims(idToken: String? = null, accessToken: String? = null): UnverifiedClaims {
    val payload = decodePayload(idToken.orEmpty()) ?: decodePayload(accessToken.orEmpty()) ?: JsonObject(emptyMap())
    val auth = runCatching { payload[CLAIM_NAMESPACE]?.jsonObject }.getOrNull()
    return UnverifiedClaims(
        accountId = runCatching { auth?.get("chatgpt_account_id")?.jsonPrimitive?.takeIf { it.isString }?.content }.getOrNull(),
        planType = runCatching { auth?.get("chatgpt_plan_type")?.jsonPrimitive?.takeIf { it.isString }?.content }.getOrNull(),
        email = runCatching { payload["email"]?.jsonPrimitive?.takeIf { it.isString }?.content }.getOrNull(),
    )
}
