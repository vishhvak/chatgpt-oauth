package dev.chatgptoauth

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

private val sseJson = Json { ignoreUnknownKeys = true }

private sealed interface ParsedBlock {
    data object Skip : ParsedBlock
    data object Done : ParsedBlock
    data class Event(val value: ResponseEvent) : ParsedBlock
}

private class SseDone : RuntimeException(null, null, false, false)

private fun parseBlock(block: String): ParsedBlock {
    var eventName = "message"
    val data = mutableListOf<String>()
    block.split('\n').forEach { line ->
        if (line.startsWith(':')) return@forEach
        val separator = line.indexOf(':')
        val field = if (separator == -1) line else line.substring(0, separator)
        val raw = if (separator == -1) "" else line.substring(separator + 1)
        val value = raw.removePrefix(" ")
        if (field == "event") eventName = value
        if (field == "data") data += value
    }
    if (data.isEmpty()) return ParsedBlock.Skip
    val joined = data.joinToString("\n")
    if (joined == "[DONE]") return ParsedBlock.Done
    // parseToJsonElement accepts bare literals JSON.parse rejects; gate it so non-JSON
    // payloads are forwarded as plain strings, matching the TypeScript reference.
    val trimmed = joined.trim()
    val looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"') ||
        trimmed in setOf("true", "false", "null") ||
        trimmed.firstOrNull()?.let { it == '-' || it.isDigit() } == true
    val parsed: JsonElement = if (looksLikeJson) {
        runCatching { sseJson.parseToJsonElement(joined) }.getOrElse { JsonPrimitive(joined) }
    } else {
        JsonPrimitive(joined)
    }
    val record = parsed as? JsonObject
    val type = record?.get("type")?.let { element ->
        runCatching { element.jsonPrimitive.takeIf { it.isString }?.contentOrNull }.getOrNull()
    } ?: eventName
    val delta = record?.get("delta")?.let { element ->
        runCatching { element.jsonPrimitive.takeIf { it.isString }?.contentOrNull }.getOrNull()
    }
    return ParsedBlock.Event(ResponseEvent(type, parsed, delta))
}

private class Utf8IncrementalDecoder {
    private val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPLACE)
        .onUnmappableCharacter(CodingErrorAction.REPLACE)
    private var pending = ByteArray(0)

    fun decode(next: ByteArray, end: Boolean): String {
        val bytes = pending + next
        val input = ByteBuffer.wrap(bytes)
        val output = CharBuffer.allocate(bytes.size + 2)
        decoder.decode(input, output, end)
        pending = ByteArray(input.remaining()).also(input::get)
        if (end) decoder.flush(output)
        output.flip()
        return output.toString()
    }
}

/** Incrementally parses UTF-8 SSE chunks, forwarding unknown events and honoring `[DONE]`. */
internal fun parseSse(chunks: Flow<ByteArray>): Flow<ResponseEvent> = flow {
    val decoder = Utf8IncrementalDecoder()
    var buffer = ""
    var stopped = false

    // Normalizes and appends only the newly decoded [text] (plus any bare trailing '\r' held back from
    // the previous call, in case it is completing a '\r\n' split across a chunk boundary), then drains
    // every complete block. Without this, normalizing the whole accumulated buffer on every chunk makes
    // one large event split across many small chunks cost O(bufferSize) per chunk, i.e. O(n^2) overall.
    fun consume(text: String, final: Boolean): List<ResponseEvent> {
        val pendingCr = buffer.isNotEmpty() && buffer.last() == '\r'
        val raw = if (pendingCr) "\r$text" else text
        if (pendingCr) buffer = buffer.dropLast(1)
        // buffer is always already normalized here (invariant maintained below), so the search only
        // needs to start at the join between the old buffer and this newly normalized suffix.
        val searchFrom = maxOf(0, buffer.length - 1)
        val collapsed = raw.replace("\r\n", "\n")
        buffer += if (final) collapsed.replace('\r', '\n') else collapsed.replace(Regex("\\r(?!$)"), "\n")

        val events = mutableListOf<ResponseEvent>()
        var boundary = buffer.indexOf("\n\n", searchFrom)
        while (boundary != -1 && !stopped) {
            when (val parsed = parseBlock(buffer.substring(0, boundary))) {
                ParsedBlock.Done -> stopped = true
                is ParsedBlock.Event -> events += parsed.value
                ParsedBlock.Skip -> Unit
            }
            buffer = buffer.substring(boundary + 2)
            boundary = buffer.indexOf("\n\n")
        }
        return events
    }

    try {
        chunks.collect { chunk ->
            consume(decoder.decode(chunk, false), false).forEach { emit(it) }
            if (stopped) throw SseDone()
        }
    } catch (_: SseDone) {
        return@flow
    }
    if (!stopped) {
        consume(decoder.decode(ByteArray(0), true), true).forEach { emit(it) }
        if (!stopped && buffer.isNotEmpty()) {
            when (val parsed = parseBlock(buffer)) {
                is ParsedBlock.Event -> emit(parsed.value)
                else -> Unit
            }
        }
    }
}
