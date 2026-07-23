package dev.chatgptoauth.android

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dev.chatgptoauth.CompareAndSwapResult
import dev.chatgptoauth.CredentialStore
import dev.chatgptoauth.StoreError
import dev.chatgptoauth.TokenSet
import dev.chatgptoauth.requireSubject
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json

/**
 * Stores subject-keyed credentials with Android Keystore-backed encryption and in-process atomic CAS.
 *
 * @param context Application context used to reach Android Keystore and preferences.
 * @param fileName Private encrypted preference file shared by store instances.
 */
public class EncryptedCredentialStore(
    context: Context,
    fileName: String = "chatgpt_oauth_credentials",
) : CredentialStore {
    private val applicationContext = context.applicationContext
    private val json = Json { ignoreUnknownKeys = true }
    private val mutex = locks.computeIfAbsent("${applicationContext.packageName}:$fileName") { Mutex() }
    private val preferences by lazy {
        EncryptedSharedPreferences.create(
            applicationContext,
            fileName,
            MasterKey.Builder(applicationContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

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
                val encoded = json.encodeToString(TokenSet.serializer(), stored)
                val committed = try {
                    preferences.edit().putString(key(subject), encoded).commit()
                } catch (cause: Exception) {
                    throw StoreError("Encrypted credential CAS could not be committed.", safeCause(cause))
                }
                if (!committed) {
                    throw StoreError("Encrypted credential CAS could not be committed.")
                }
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
            }
        }
    }

    private fun read(subject: String): TokenSet? {
        val encoded = try {
            preferences.getString(key(subject), null)
        } catch (cause: Exception) {
            throw StoreError("Encrypted credentials could not be authenticated.", safeCause(cause))
        } ?: return null
        return try {
            json.decodeFromString(TokenSet.serializer(), encoded)
        } catch (cause: Exception) {
            throw StoreError("Encrypted credentials contained an invalid record.", safeCause(cause))
        }
    }

    private fun key(subject: String): String = "subject:$subject"

    private fun safeCause(cause: Throwable): Throwable = IllegalStateException(cause::class.simpleName ?: "storage failure")

    private companion object {
        val locks = ConcurrentHashMap<String, Mutex>()
    }
}
