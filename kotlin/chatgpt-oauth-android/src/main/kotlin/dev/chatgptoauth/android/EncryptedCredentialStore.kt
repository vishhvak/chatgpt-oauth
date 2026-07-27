package dev.chatgptoauth.android

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import dev.chatgptoauth.CompareAndSwapResult
import dev.chatgptoauth.CredentialStore
import dev.chatgptoauth.StoreError
import dev.chatgptoauth.TokenSet
import dev.chatgptoauth.requireSubject
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json

/**
 * Stores subject-keyed credentials under an Android Keystore AES-256-GCM key with in-process atomic CAS.
 *
 * Each record is sealed into the protocol's own envelope — `base64(iv).base64(tag).base64(ciphertext)`,
 * fresh IV per write — and the sealed string is what lands in an ordinary private `SharedPreferences`
 * file. The key never leaves the Keystore, so it stays hardware-backed where the device provides it.
 *
 * This replaces `androidx.security:security-crypto` / `EncryptedSharedPreferences`, which Google
 * deprecated in April 2025 at `1.1.0-alpha07` and never shipped as stable. Records written by that
 * earlier implementation are migrated on first read (see [migrateLegacyRecord]); nobody is signed out
 * by upgrading.
 *
 * @param context Application context used to reach Android Keystore and preferences.
 * @param fileName Private preference file shared by store instances.
 */
public class EncryptedCredentialStore(
    context: Context,
    fileName: String = "chatgpt_oauth_credentials",
) : CredentialStore {
    private val applicationContext = context.applicationContext
    private val fileName = fileName
    private val json = Json { ignoreUnknownKeys = true }
    private val mutex = locks.computeIfAbsent("${applicationContext.packageName}:$fileName") { Mutex() }
    private val envelope = CredentialEnvelope(AndroidBase64)
    private val preferences: SharedPreferences by lazy {
        applicationContext.getSharedPreferences("${fileName}_v2", Context.MODE_PRIVATE)
    }
    private val key: SecretKey by lazy { keystoreKey("${applicationContext.packageName}:$fileName") }

    override suspend fun load(subject: String): TokenSet? {
        requireSubject(subject)
        return withContext(Dispatchers.IO) { mutex.withLock { read(subject) } }
    }

    override suspend fun compareAndSwap(
        subject: String,
        expectedVersion: Long,
        next: TokenSet,
    ): CompareAndSwapResult {
        requireSubject(subject)
        require(expectedVersion >= 0) { "expectedVersion must be nonnegative." }
        return withContext(Dispatchers.IO) {
            mutex.withLock {
                val current = read(subject)
                if ((current?.version ?: 0L) != expectedVersion) return@withLock CompareAndSwapResult(false, current)
                val stored = next.copy(version = expectedVersion + 1L)
                write(subject, stored)
                CompareAndSwapResult(true, stored)
            }
        }
    }

    override suspend fun delete(subject: String) {
        requireSubject(subject)
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val committed = try {
                    preferences.edit().remove(key(subject)).commit()
                } catch (cause: Exception) {
                    throw StoreError("Encrypted credential deletion could not be committed.", safeCause(cause))
                }
                if (!committed) {
                    throw StoreError("Encrypted credential deletion could not be committed.")
                }
                LegacyEncryptedPreferences.remove(applicationContext, fileName, key(subject))
            }
        }
    }

    private fun write(subject: String, token: TokenSet) {
        val sealed = try {
            envelope.seal(json.encodeToString(TokenSet.serializer(), token), key)
        } catch (cause: Exception) {
            throw StoreError("Encrypted credential CAS could not be sealed.", safeCause(cause))
        }
        val committed = try {
            preferences.edit().putString(key(subject), sealed).commit()
        } catch (cause: Exception) {
            throw StoreError("Encrypted credential CAS could not be committed.", safeCause(cause))
        }
        if (!committed) {
            throw StoreError("Encrypted credential CAS could not be committed.")
        }
    }

    private fun read(subject: String): TokenSet? {
        val sealed = try {
            preferences.getString(key(subject), null)
        } catch (cause: Exception) {
            throw StoreError("Encrypted credentials could not be read.", safeCause(cause))
        } ?: return migrateLegacyRecord(subject)

        val decoded = try {
            envelope.open(sealed, key)
        } catch (cause: Exception) {
            // Authentication failure is a typed store error, never an empty record: silently
            // returning null here would look like "logged out" and destroy the user's session.
            throw StoreError("Encrypted credentials could not be authenticated.", safeCause(cause))
        }
        return decode(decoded)
    }

    /**
     * Reads a record left by the deprecated `EncryptedSharedPreferences` implementation, rewrites it
     * into the current envelope, and drops the old entry. Returns null when there is nothing to
     * migrate, which is the normal path for every install after the first read.
     */
    private fun migrateLegacyRecord(subject: String): TokenSet? {
        val legacy = LegacyEncryptedPreferences.read(applicationContext, fileName, key(subject)) ?: return null
        val token = decode(legacy)
        write(subject, token)
        LegacyEncryptedPreferences.remove(applicationContext, fileName, key(subject))
        return token
    }

    private fun decode(encoded: String): TokenSet = try {
        json.decodeFromString(TokenSet.serializer(), encoded)
    } catch (cause: Exception) {
        throw StoreError("Encrypted credentials contained an invalid record.", safeCause(cause))
    }

    private fun key(subject: String): String = "subject:$subject"

    private fun safeCause(cause: Throwable): Throwable = IllegalStateException(cause::class.simpleName ?: "storage failure")

    private companion object {
        val locks = ConcurrentHashMap<String, Mutex>()

        /** Fetches the Keystore key for [alias], creating a hardware-backed one on first use. */
        fun keystoreKey(alias: String): SecretKey {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            generator.init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            return generator.generateKey()
        }

        const val ANDROID_KEYSTORE = "AndroidKeyStore"
    }
}

/** `android.util.Base64` so the store keeps working below API 26, where `java.util.Base64` is absent. */
private object AndroidBase64 : Base64Codec {
    override fun encode(bytes: ByteArray): String =
        android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)

    override fun decode(value: String): ByteArray =
        android.util.Base64.decode(value, android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
}
