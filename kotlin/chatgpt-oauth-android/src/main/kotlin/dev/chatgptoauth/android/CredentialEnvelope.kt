package dev.chatgptoauth.android

import java.security.GeneralSecurityException
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Standard-alphabet Base64, injected rather than called directly.
 *
 * `android.util.Base64` is an unimplemented stub in JVM unit tests, and `java.util.Base64` needs
 * API 26 while this module's `minSdk` is 23. Injecting the codec lets the envelope format itself be
 * covered by ordinary JVM tests while the store still uses the platform implementation on device.
 */
internal interface Base64Codec {
    fun encode(bytes: ByteArray): String
    fun decode(value: String): ByteArray
}

/**
 * The at-rest envelope the protocol specifies: AES-256-GCM, a fresh 12-byte IV per write, a 16-byte
 * authentication tag, and the three parts joined as `base64(iv).base64(tag).base64(ciphertext)` —
 * byte-for-byte the format the TypeScript and Python file stores already write.
 *
 * Keeping the crypto here, separate from Android Keystore and SharedPreferences, is what makes it
 * testable off-device: the key is a parameter, so a plain JVM `SecretKeySpec` works in tests and a
 * hardware-backed Keystore key works in production.
 */
internal class CredentialEnvelope(
    private val codec: Base64Codec,
    private val random: SecureRandom = SecureRandom(),
) {
    fun seal(plaintext: String, key: SecretKey): String {
        val iv = ByteArray(IV_BYTES).also(random::nextBytes)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        val sealed = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        // JCE returns ciphertext||tag; the envelope keeps them as separate fields.
        val boundary = sealed.size - TAG_BYTES
        val tag = sealed.copyOfRange(boundary, sealed.size)
        val ciphertext = sealed.copyOfRange(0, boundary)
        return "${codec.encode(iv)}.${codec.encode(tag)}.${codec.encode(ciphertext)}"
    }

    /** @throws GeneralSecurityException when the envelope is malformed or fails authentication. */
    fun open(envelope: String, key: SecretKey): String {
        val parts = envelope.split(".")
        if (parts.size != 3) throw GeneralSecurityException("Credential envelope is malformed.")
        val iv: ByteArray
        val tag: ByteArray
        val ciphertext: ByteArray
        try {
            iv = codec.decode(parts[0])
            tag = codec.decode(parts[1])
            ciphertext = codec.decode(parts[2])
        } catch (cause: IllegalArgumentException) {
            throw GeneralSecurityException("Credential envelope is malformed.", cause)
        }
        if (iv.size != IV_BYTES || tag.size != TAG_BYTES) {
            throw GeneralSecurityException("Credential envelope is malformed.")
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        // A tampered tag surfaces as AEADBadTagException, a GeneralSecurityException subclass, which
        // the store turns into a typed StoreError rather than a silent "logged out".
        return cipher.doFinal(ciphertext + tag).toString(Charsets.UTF_8)
    }

    internal companion object {
        const val IV_BYTES: Int = 12
        const val TAG_BYTES: Int = 16
        const val TAG_BITS: Int = TAG_BYTES * 8
        const val TRANSFORMATION: String = "AES/GCM/NoPadding"
    }
}
