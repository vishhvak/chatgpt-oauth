package dev.chatgptoauth.store

import dev.chatgptoauth.CompareAndSwapResult
import dev.chatgptoauth.CredentialStore
import dev.chatgptoauth.TokenSet
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Provides an ephemeral subject-keyed store seeded by [initial] for tests and local development only. */
public class MemoryCredentialStore(initial: Map<String, TokenSet> = emptyMap()) : CredentialStore {
    private val mutex = Mutex()
    private val records = initial.toMutableMap()

    override suspend fun load(subject: String): TokenSet? {
        requireSubject(subject)
        return mutex.withLock { records[subject] }
    }

    override suspend fun compareAndSwap(
        subject: String,
        expectedVersion: Long,
        next: TokenSet,
    ): CompareAndSwapResult {
        requireSubject(subject)
        require(expectedVersion >= 0) { "expectedVersion must be nonnegative." }
        return mutex.withLock {
            val current = records[subject]
            if ((current?.version ?: 0L) != expectedVersion) return@withLock CompareAndSwapResult(false, current)
            val stored = next.copy(version = expectedVersion + 1)
            records[subject] = stored
            CompareAndSwapResult(true, stored)
        }
    }

    override suspend fun delete(subject: String) {
        requireSubject(subject)
        mutex.withLock { records.remove(subject) }
    }

    private fun requireSubject(subject: String) {
        require(subject.isNotBlank()) { "subject must be a nonempty server-derived identifier." }
    }
}
