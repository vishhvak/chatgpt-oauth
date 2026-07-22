package dev.chatgptoauth

import java.io.IOException
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer

private val oauthJson = Json { ignoreUnknownKeys = true }
private val jsonMediaType = "application/json".toMediaType()

internal class TokenEndpointFailure(
    val status: Int,
    val errorCode: String?,
    val terminal: Boolean,
    message: String,
) : Exception(redact(message))

internal suspend fun Call.awaitResponse(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, exception: IOException) {
            if (continuation.isActive) continuation.resumeWithException(exception)
        }

        override fun onResponse(call: Call, response: Response) {
            if (continuation.isActive) continuation.resume(response) else response.close()
        }
    })
}

private fun sanitizedCause(cause: Throwable): Throwable = IOException(redact(cause.message ?: cause::class.simpleName.orEmpty()))

private fun retryAfter(response: Response, now: Long): Long? {
    val value = response.header("retry-after") ?: return null
    value.toDoubleOrNull()?.takeIf(Double::isFinite)?.let { return maxOf(0L, (it * 1_000).toLong()) }
    val instant = runCatching { ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant() }.getOrNull()
    return instant?.toEpochMilli()?.minus(now)?.coerceAtLeast(0L)
}

private fun Response.readRedacted(readLimit: Long = 65_536L): String = use { response ->
    val source = response.body?.source() ?: return@use ""
    val bytes = runCatching {
        val sink = Buffer()
        while (sink.size < readLimit) {
            val read = source.read(sink, minOf(8_192L, readLimit - sink.size))
            if (read == -1L) break
        }
        sink.readByteArray()
    }.getOrElse { error ->
        return@use redact(" [response read failed: ${error.message.orEmpty()}]")
    }
    redact(bytes.toString(Charsets.UTF_8))
}

private fun Response.readBody(): String = use { response -> response.body?.string().orEmpty() }

private fun parseObject(body: String, message: String): JsonObject = try {
    oauthJson.parseToJsonElement(body).jsonObject
} catch (cause: Throwable) {
    throw TransportError(message, sanitizedCause(cause))
}

/**
 * Owns OAuth wire calls, token normalization, device polling, and terminal-error classification.
 *
 * @property protocol Endpoint and timing configuration, normally the production defaults.
 */
public class OAuth(
    private val client: OkHttpClient = OkHttpClient(),
    public val protocol: ProtocolConfig = ProtocolConfig(),
    private val now: () -> Long = System::currentTimeMillis,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    /** Creates a protected PKCE login and its browser authorization URL. */
    public suspend fun beginLogin(redirectUri: String = protocol.loopbackRedirect): PendingLogin {
        val generated = createPkce()
        val url = protocol.authorizeUrl.toHttpUrl().newBuilder().apply {
            addQueryParameter("response_type", "code")
            addQueryParameter("client_id", protocol.clientId)
            addQueryParameter("redirect_uri", redirectUri)
            addQueryParameter("scope", protocol.scopes)
            addQueryParameter("code_challenge", generated.challenge)
            addQueryParameter("code_challenge_method", "S256")
            addQueryParameter("state", generated.state)
            protocol.extraAuthParams.forEach { (key, value) -> addQueryParameter(key, value) }
        }.build()
        return PendingLogin(url.toString(), generated.state, generated.verifier, redirectUri)
    }

    /** Validates callback state before exchanging its authorization code. */
    public suspend fun completeLogin(callbackUrl: String, pending: PendingLogin): TokenSet {
        val callback = runCatching { callbackUrl.toHttpUrl() }
            .getOrElse { throw AuthError("Authorization callback URL was invalid.") }
        assertState(pending.state, callback.queryParameter("state"))
        callback.queryParameter("error")?.let { throw AuthError("Authorization failed: ${redact(it)}") }
        val code = callback.queryParameter("code")
        if (code.isNullOrEmpty()) throw AuthError("Authorization callback omitted the code.")
        return exchange(code, pending.verifier, pending.redirectUri)
    }

    internal suspend fun exchange(
        code: String,
        verifier: String,
        redirectUri: String,
        previous: TokenSet? = null,
    ): TokenSet {
        val body = FormBody.Builder()
            .add("grant_type", "authorization_code")
            .add("client_id", protocol.clientId)
            .add("code", code)
            .add("code_verifier", verifier)
            .add("redirect_uri", redirectUri)
            .build()
        val response = execute(Request.Builder().url(protocol.tokenUrl).post(body).build(), "Authorization code exchange")
        if (!response.isSuccessful) failure(response, "code exchange")
        return normalizeToken(parseObject(response.readBody(), "OAuth endpoint returned invalid JSON."), previous)
    }

    /** Refreshes one credential generation with bounded transient retries. */
    public suspend fun refresh(previous: TokenSet): TokenSet {
        repeat(3) { attempt ->
            val request = Request.Builder().url(protocol.tokenUrl).post(
                FormBody.Builder()
                    .add("grant_type", "refresh_token")
                    .add("client_id", protocol.clientId)
                    .add("refresh_token", previous.refreshToken)
                    .add("scope", protocol.scopes)
                    .build(),
            ).build()
            val response = try {
                client.newCall(request).awaitResponse()
            } catch (cause: Throwable) {
                if (cause is CancellationException) throw cause
                if (attempt < 2) {
                    sleep(250L shl attempt)
                    return@repeat
                }
                throw TokenRefreshError("Token refresh failed due to a network error.", sanitizedCause(cause))
            }
            if (response.code >= 500 && attempt < 2) {
                response.close()
                sleep(250L shl attempt)
                return@repeat
            }
            if (response.code == 429 && attempt < 2) {
                val wait = retryAfter(response, now()) ?: (250L shl attempt)
                response.close()
                sleep(wait)
                return@repeat
            }
            if (!response.isSuccessful) failure(response, "refresh")
            return try {
                normalizeToken(parseObject(response.readBody(), "OAuth endpoint returned invalid JSON."), previous)
            } catch (cause: RateLimitError) {
                throw cause
            } catch (cause: Throwable) {
                throw TokenRefreshError("Token refresh returned an invalid response.", sanitizedCause(cause))
            }
        }
        throw TokenRefreshError()
    }

    internal suspend fun startDeviceLogin(onComplete: suspend (TokenSet) -> TokenSet): DeviceLogin {
        val request = Request.Builder().url(protocol.deviceUserCodeUrl)
            .header("accept", "application/json")
            .post("{\"client_id\":\"${protocol.clientId}\"}".toRequestBody(jsonMediaType))
            .build()
        val response = execute(request, "Device authorization")
        if (!response.isSuccessful) failure(response, "device authorization")
        val payload = parseObject(response.readBody(), "OAuth endpoint returned invalid JSON.")
        val userCode = string(payload, "user_code") ?: string(payload, "usercode")
        val deviceAuthId = string(payload, "device_auth_id")
        if (userCode == null || deviceAuthId == null) {
            throw TransportError("Device authorization returned an invalid response.")
        }
        var interval = number(payload, "interval")?.times(1_000)?.toLong() ?: 5_000L
        val expiresAt = now() + (number(payload, "expires_in")?.times(1_000)?.toLong() ?: 900_000L)
        return DeviceLogin(userCode, protocol.deviceVerifyUrl, expiresAt, awaitTokens = await@{
            while (now() < expiresAt) {
                sleep(interval)
                if (now() >= expiresAt) break
                val pollRequest = Request.Builder().url(protocol.devicePollUrl)
                    .header("accept", "application/json")
                    .post(
                        oauthJson.encodeToString(
                            JsonObject.serializer(),
                            JsonObject(mapOf("device_auth_id" to JsonPrimitive(deviceAuthId), "user_code" to JsonPrimitive(userCode))),
                        ).toRequestBody(jsonMediaType),
                    ).build()
                val poll = execute(pollRequest, "Device authorization poll")
                val status = poll.code
                val rawBody = poll.readRedacted()
                val pollBody = runCatching { oauthJson.parseToJsonElement(rawBody).jsonObject }.getOrElse {
                    if (status == 403 || status == 404) JsonObject(emptyMap())
                    else throw TransportError("OAuth endpoint returned invalid JSON.", sanitizedCause(it))
                }
                val pollError = string(pollBody, "error")
                if (pollError == "authorization_pending" || status == 403 || status == 404) continue
                if (pollError == "slow_down") {
                    interval += 5_000L
                    continue
                }
                if (status !in 200..299) throw AuthError("Device authorization failed ($status).")
                val authorizationCode = string(pollBody, "authorization_code")
                val codeVerifier = string(pollBody, "code_verifier")
                if (authorizationCode == null || codeVerifier == null) {
                    throw TransportError("Device poll returned an invalid success response.")
                }
                return@await onComplete(exchange(authorizationCode, codeVerifier, protocol.deviceRedirectUrl))
            }
            throw AuthError("Device authorization expired.")
        })
    }

    private suspend fun execute(request: Request, context: String): Response = try {
        client.newCall(request).awaitResponse()
    } catch (cause: Throwable) {
        if (cause is CancellationException) throw cause
        throw TransportError("$context failed due to a network error.", sanitizedCause(cause))
    }

    private fun failure(response: Response, context: String): Nothing {
        val status = response.code
        val retryAfterMs = retryAfter(response, now())
        val body = response.readRedacted()
        val snippet = body.take(1_024)
        val parsed = runCatching { oauthJson.parseToJsonElement(body).jsonObject }.getOrNull()
        val error = parsed?.get("error")
        val errorCode = when (error) {
            is JsonPrimitive -> error.takeIf { it.isString }?.content
            is JsonObject -> string(error, "code")
            else -> null
        }
        if (status == 429) throw RateLimitError(retryAfterMs)
        val terminal = status == 401 || status == 403 ||
            (status in 400..499 && errorCode in setOf("invalid_grant", "invalid_token", "invalid_request"))
        if (context == "refresh") {
            throw TokenEndpointFailure(status, errorCode, terminal, "$context failed ($status): $snippet")
        }
        throw AuthError("$context failed ($status): $snippet")
    }

    private fun normalizeToken(payload: JsonObject, previous: TokenSet?): TokenSet {
        val accessToken = string(payload, "access_token")?.takeIf(String::isNotEmpty)
            ?: throw TransportError("Token endpoint returned an invalid response.")
        val timestamp = now()
        val expiresIn = number(payload, "expires_in")
        val candidate = expiresIn?.let { timestamp.toDouble() + it * 1_000.0 }
        val expiresAt = candidate?.takeIf {
            it.isFinite() && it <= Long.MAX_VALUE.toDouble() && it >= Long.MIN_VALUE.toDouble()
        }?.toLong() ?: timestamp
        val refreshToken = string(payload, "refresh_token") ?: previous?.refreshToken
            ?: throw TransportError("Token endpoint omitted the refresh token.")
        val idToken = string(payload, "id_token") ?: previous?.idToken
        val claims = extractUnverifiedClaims(idToken, accessToken)
        return TokenSet(
            accessToken = accessToken,
            refreshToken = refreshToken,
            idToken = idToken,
            expiresAt = expiresAt,
            accountId = claims.accountId,
            planType = claims.planType,
            email = claims.email,
            version = (previous?.version ?: 0L) + 1L,
        )
    }

    private fun string(payload: JsonObject, key: String): String? = payload[key]?.let { element ->
        runCatching { element.jsonPrimitive.takeIf { it.isString }?.content }.getOrNull()
    }

    private fun number(payload: JsonObject, key: String): Double? = payload[key]?.let { element ->
        runCatching { element.jsonPrimitive.doubleOrNull }.getOrNull()
    }
}
