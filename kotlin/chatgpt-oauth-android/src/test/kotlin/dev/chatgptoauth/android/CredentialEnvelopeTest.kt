package dev.chatgptoauth.android

import java.security.GeneralSecurityException
import java.util.Base64
import javax.crypto.spec.SecretKeySpec
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * Covers the at-rest envelope off-device. Android Keystore cannot run here, so the key is a plain
 * JVM key: that is exactly why [CredentialEnvelope] takes the key as a parameter instead of reaching
 * for the Keystore itself.
 */
class CredentialEnvelopeTest {
    private val codec = object : Base64Codec {
        override fun encode(bytes: ByteArray): String = Base64.getEncoder().withoutPadding().encodeToString(bytes)
        override fun decode(value: String): ByteArray = Base64.getDecoder().decode(value)
    }
    private val envelope = CredentialEnvelope(codec)
    private val key = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")
    private val record = """{"accessToken":"a","refreshToken":"r","expiresAt":1,"version":1}"""

    @Test
    fun `round trips a record`() {
        assertEquals(record, envelope.open(envelope.seal(record, key), key))
    }

    @Test
    fun `emits base64 iv, tag, and ciphertext with the specified sizes`() {
        val parts = envelope.seal(record, key).split(".")
        assertEquals(3, parts.size)
        assertEquals(CredentialEnvelope.IV_BYTES, codec.decode(parts[0]).size)
        assertEquals(CredentialEnvelope.TAG_BYTES, codec.decode(parts[1]).size)
        // GCM is a stream cipher: ciphertext length equals plaintext length, tag held separately.
        assertEquals(record.toByteArray().size, codec.decode(parts[2]).size)
    }

    @Test
    fun `uses a fresh iv for every write`() {
        val ivs = (0 until 50).map { envelope.seal(record, key).split(".")[0] }
        assertEquals(50, ivs.toSet().size, "an IV was reused, which breaks GCM confidentiality")
    }

    @Test
    fun `rejects a tampered ciphertext rather than returning a record`() {
        val parts = envelope.seal(record, key).split(".")
        val ciphertext = codec.decode(parts[2])
        ciphertext[0] = (ciphertext[0].toInt() xor 0x01).toByte()
        val tampered = "${parts[0]}.${parts[1]}.${codec.encode(ciphertext)}"
        assertThrows<GeneralSecurityException> { envelope.open(tampered, key) }
    }

    @Test
    fun `rejects a tampered tag rather than returning a record`() {
        val parts = envelope.seal(record, key).split(".")
        val tag = codec.decode(parts[1])
        tag[0] = (tag[0].toInt() xor 0x01).toByte()
        val tampered = "${parts[0]}.${codec.encode(tag)}.${parts[2]}"
        assertThrows<GeneralSecurityException> { envelope.open(tampered, key) }
    }

    @Test
    fun `rejects the wrong key rather than returning a record`() {
        val other = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")
        assertThrows<GeneralSecurityException> { envelope.open(envelope.seal(record, key), other) }
    }

    @Test
    fun `rejects malformed envelopes`() {
        for (malformed in listOf("", "onlyonepart", "two.parts", "a.b.c.d", "!!!.!!!.!!!")) {
            assertThrows<GeneralSecurityException>("expected rejection for \"$malformed\"") {
                envelope.open(malformed, key)
            }
        }
    }

    @Test
    fun `rejects an iv or tag of the wrong length`() {
        val parts = envelope.seal(record, key).split(".")
        val shortIv = "${codec.encode(ByteArray(8))}.${parts[1]}.${parts[2]}"
        val shortTag = "${parts[0]}.${codec.encode(ByteArray(8))}.${parts[2]}"
        assertThrows<GeneralSecurityException> { envelope.open(shortIv, key) }
        assertThrows<GeneralSecurityException> { envelope.open(shortTag, key) }
    }

    @Test
    fun `never leaks plaintext into the envelope`() {
        val secret = "super-secret-refresh-token"
        val sealed = envelope.seal("""{"refreshToken":"$secret"}""", key)
        assertTrue(secret !in sealed)
    }

    @Test
    fun `produces a different ciphertext for the same plaintext`() {
        assertNotEquals(envelope.seal(record, key), envelope.seal(record, key))
    }

    @Test
    fun `preserves exact bytes including multibyte characters`() {
        val unicode = """{"email":"tëst+ünïcode@example.com","note":"日本語"}"""
        val opened = envelope.open(envelope.seal(unicode, key), key)
        assertContentEquals(unicode.toByteArray(Charsets.UTF_8), opened.toByteArray(Charsets.UTF_8))
    }
}
