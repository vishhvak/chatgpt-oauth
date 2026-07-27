package dev.chatgptoauth

import java.io.InputStream
import java.util.UUID
import kotlinx.serialization.json.buildJsonObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** Implements the subject-bound Responses transport with exactly one reactive auth retry. */
public class SubscriptionAI(
    private val auth: AuthSession,
    private val subject: String,
    private val client: OkHttpClient = OkHttpClient(),
    private val protocol: ProtocolConfig = auth.protocol,
    private val sessionId: String = UUID.randomUUID().toString(),
    private val onRateLimits: ((RateLimitSnapshot) -> Unit)? = null,
) {
    /** Holds the usage headers from the latest completed stream, when one has run. */
    @Volatile
    public var lastRateLimits: RateLimitSnapshot? = null
        private set

    init {
        requireSubject(subject)
    }

    /** Returns a cold Flow of parsed response events. */
    public fun stream(req: ResponseRequest): Flow<ResponseEvent> = flow {
        val response = send(req, false)
        val snapshot = parseRateLimitHeaders(response)
        try {
            val body = response.body ?: throw TransportError("Subscription transport returned no response stream.")
            parseSse(body.byteStream().byteChunks()).collect { emit(it) }
        } catch (cause: ChatGPTOAuthException) {
            throw cause
        } catch (cause: Throwable) {
            if (cause is CancellationException) throw cause
            throw TransportError("Subscription stream failed: ${redact(cause.message.orEmpty()).take(1_024)}")
        } finally {
            response.close()
            captureRateLimits(snapshot)
        }
    }.flowOn(Dispatchers.IO)

    /** Streams one response internally and returns its collected result. */
    public suspend fun respond(req: ResponseRequest): ResponseResult {
        val events = mutableListOf<ResponseEvent>()
        val output = StringBuilder()
        var completed: JsonElement? = null
        stream(req).collect { event ->
            events += event
            if (event.type == "response.output_text.delta" && event.delta != null) output.append(event.delta)
            if (event.type == "response.completed") completed = event.data
        }
        return ResponseResult(output.toString(), events, completed)
    }

    private suspend fun send(req: ResponseRequest, retried: Boolean): Response {
        require(req.model.isNotBlank()) { "model must be nonempty." }
        val tokenSet = auth.getTokenSet(subject, forceRefresh = retried)
        val separator = if ("?" in protocol.responsesUrl) "&" else "?"
        // The backend rejects requests without client_version (400 missing query param).
        val request = Request.Builder().url("${protocol.responsesUrl}${separator}client_version=${protocol.clientVersion}")
            .header("authorization", "Bearer ${tokenSet.accessToken}")
            .header("openai-beta", "responses=experimental")
            .header("originator", "codex_cli_rs")
            .header("content-type", "application/json")
            .header("session_id", sessionId)
            .apply { tokenSet.accountId?.let { header("chatgpt-account-id", it) } }
            .post(requestBody(req).toString().toRequestBody("application/json".toMediaType()))
            .build()
        val response = try {
            client.newCall(request).awaitResponse()
        } catch (cause: Throwable) {
            if (cause is CancellationException) throw cause
            throw TransportError("Subscription request failed: ${redact(cause.message.orEmpty()).take(1_024)}")
        }
        if (response.code == 401) {
            response.close()
            if (retried) throw AuthError("Authentication was rejected after one refresh retry.")
            return send(req, true)
        }
        if (response.code == 429) {
            val retryAfter = parseRetryAfterMs(response.header("retry-after"), System.currentTimeMillis())
            response.close()
            throw RateLimitError(retryAfter)
        }
        if (!response.isSuccessful) {
            val status = response.code
            // 1024 characters, matching the TypeScript, Python and Swift ports. Without the explicit
            // bound this defaults to outputLimit = readLimit = 4096 and emits 4x more text than they do.
            val snippet = response.readRedactedSnippet(outputLimit = 1_024)
            throw TransportError("Subscription transport failed ($status): $snippet")
        }
        return response
    }

    private fun requestBody(req: ResponseRequest): JsonObject = JsonObject(buildMap {
        put("model", JsonPrimitive(req.model))
        req.instructions?.let { put("instructions", JsonPrimitive(it)) }
        put("input", when (val input = req.input) {
            // The backend rejects bare-string input ("Input must be a list"); wrap as one user message.
            is ResponseContent.Text -> JsonArray(listOf(buildJsonObject {
                put("type", JsonPrimitive("message"))
                put("role", JsonPrimitive("user"))
                put("content", JsonArray(listOf(buildJsonObject {
                    put("type", JsonPrimitive("input_text"))
                    put("text", JsonPrimitive(input.value))
                })))
            }))
            is ResponseContent.Items -> JsonArray(input.value)
        })
        req.tools?.let { put("tools", JsonArray(it)) }
        req.toolChoice?.let { put("tool_choice", it) }
        put("parallel_tool_calls", JsonPrimitive(false))
        put("store", JsonPrimitive(false))
        put("stream", JsonPrimitive(true))
        req.reasoning?.let { put("reasoning", it) }
        req.include?.let { values -> put("include", JsonArray(values.map { JsonPrimitive(it) })) }
    })

    private fun captureRateLimits(snapshot: RateLimitSnapshot) {
        lastRateLimits = snapshot
        runCatching { onRateLimits?.invoke(snapshot) }
    }
}

/** Parses complete or partial Codex rate-limit headers without inventing absent windows. */
internal fun parseRateLimitHeaders(response: Response): RateLimitSnapshot = RateLimitSnapshot(
    primary = rateWindow(response, "primary"),
    secondary = rateWindow(response, "secondary"),
)

private fun rateWindow(response: Response, prefix: String): RateLimitWindow? {
    val used = response.finiteHeader("x-codex-$prefix-used-percent") ?: return null
    return RateLimitWindow(
        used,
        response.finiteHeader("x-codex-$prefix-window-minutes"),
        response.finiteHeader("x-codex-$prefix-reset-at"),
    )
}

private fun Response.finiteHeader(name: String): Double? = header(name)?.trim()?.takeIf(String::isNotEmpty)
    ?.toDoubleOrNull()?.takeIf(Double::isFinite)

private fun InputStream.byteChunks(): Flow<ByteArray> = flow {
    use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = input.read(buffer)
            if (count == -1) break
            emit(buffer.copyOf(count))
        }
    }
}
