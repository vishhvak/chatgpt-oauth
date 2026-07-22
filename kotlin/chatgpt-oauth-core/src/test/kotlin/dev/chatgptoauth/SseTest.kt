package dev.chatgptoauth

import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class SseTest {
    @Test
    fun `parses split multiline unknown and done frames`() = runTest {
        val chunks = flowOf(
            "event: response.output_".toByteArray(),
            "text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n".toByteArray(),
            "event: future.event\ndata: first\ndata: second\n\n".toByteArray(),
            "data: [DO".toByteArray(),
            "NE]\r".toByteArray(),
            "\n\r\nevent: ignored\ndata: after\n\n".toByteArray(),
        )
        val events = parseSse(chunks).toList()
        assertEquals(2, events.size)
        assertEquals("response.output_text.delta", events[0].type)
        assertEquals("Hi", events[0].delta)
        assertEquals(ResponseEvent("future.event", JsonPrimitive("first\nsecond")), events[1])
    }

    @Test
    fun `parses a trailing block without a final blank line`() = runTest {
        assertEquals(
            listOf(ResponseEvent("custom", JsonPrimitive("opaque"))),
            parseSse(flowOf("event: custom\ndata: opaque".toByteArray())).toList(),
        )
    }
}
