package dev.chatgptoauth

import java.lang.ref.WeakReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

private data class RefreshResult(val token: TokenSet, val refreshed: Boolean)
private data class RefreshFlight(val force: Boolean, val deferred: Deferred<RefreshResult>)
private class FlightRegistry {
    val mutex = Mutex()
    val flights = mutableMapOf<String, RefreshFlight>()
}

/**
 * Coordinates explicit-subject OAuth custody, singleflight refresh, CAS, quarantine, and a kill switch.
 *
 * @property protocol Endpoint and refresh-margin configuration used by this session.
 */
public class AuthSession(
    private val store: CredentialStore,
    client: OkHttpClient = OkHttpClient(),
    private val now: () -> Long = System::currentTimeMillis,
    sleep: suspend (Long) -> Unit = { delay(it) },
    private val disabled: () -> Boolean = { false },
    public val protocol: ProtocolConfig = ProtocolConfig(),
) {
    private val oauth = OAuth(client, protocol, now, sleep)
    private val registry = registryFor(store)

    /** Creates protected browser-login state without loading or selecting any credential subject. */
    public suspend fun beginLogin(redirectUri: String = protocol.loopbackRedirect): PendingLogin = oauth.beginLogin(redirectUri)

    /** Exchanges a callback and persists it only for the explicit server-derived subject. */
    public suspend fun completeLogin(subject: String, callbackUrl: String, pending: PendingLogin): TokenSet {
        requireSubject(subject)
        if (disabled()) throw DisabledError()
        return persistFresh(subject, oauth.completeLogin(callbackUrl, pending))
    }

    /** Starts a device flow whose successful exchange persists only for the explicit subject. */
    public suspend fun startDeviceLogin(subject: String): DeviceLogin {
        requireSubject(subject)
        if (disabled()) throw DisabledError()
        return oauth.startDeviceLogin { token -> persistFresh(subject, token) }
    }

    /** Returns a valid access token for the explicit subject, refreshing near expiry. */
    public suspend fun getAccessToken(subject: String): String {
        requireSubject(subject)
        if (disabled()) throw DisabledError()
        val token = store.load(subject) ?: throw ReauthRequiredError(subject, "missing_credentials")
        if (token.quarantinedAt != null) throw ReauthRequiredError(subject, token.quarantineReason ?: "quarantined")
        if (token.expiresAt - now() >= protocol.refreshMarginMs) return token.accessToken
        return inFlight(subject, false).token.accessToken
    }

    /** Forces a network refresh for the explicit subject without accepting a skipped non-forced flight. */
    public suspend fun refreshAccessToken(subject: String): String {
        requireSubject(subject)
        if (disabled()) throw DisabledError()
        return inFlight(subject, true).token.accessToken
    }

    /** Returns safe connection metadata for the explicit subject without exposing tokens. */
    public suspend fun status(subject: String): Session? {
        requireSubject(subject)
        if (disabled()) throw DisabledError()
        val token = store.load(subject) ?: return null
        return Session(
            subject = subject,
            status = if (token.quarantinedAt == null) SessionStatus.CONNECTED else SessionStatus.QUARANTINED,
            expiresAt = token.expiresAt,
            accountId = token.accountId,
            planType = token.planType,
            email = token.email,
            reason = token.quarantineReason,
        )
    }

    /** Deletes local credentials for the explicit subject without calling a revoke endpoint. */
    public suspend fun logout(subject: String) {
        requireSubject(subject)
        store.delete(subject)
    }

    private suspend fun persistFresh(subject: String, token: TokenSet): TokenSet {
        val current = store.load(subject)
        val expectedVersion = current?.version ?: 0L
        val next = token.copy(
            version = expectedVersion + 1L,
            quarantinedAt = null,
            quarantineReason = null,
        )
        val saved = store.compareAndSwap(subject, expectedVersion, next)
        if (saved.ok) return next
        return saved.current ?: throw AuthError("Credentials changed while sign-in completed.")
    }

    private suspend fun quarantine(subject: String, token: TokenSet, reason: String): TokenSet {
        val marker = token.copy(
            version = token.version + 1L,
            quarantinedAt = now(),
            quarantineReason = redact(reason),
        )
        val result = store.compareAndSwap(subject, token.version, marker)
        val current = result.current
        if (!result.ok && current != null && current.quarantinedAt == null) return current
        throw ReauthRequiredError(subject, current?.quarantineReason ?: reason)
    }

    private suspend fun refreshOne(subject: String, force: Boolean): RefreshResult {
        val current = store.load(subject) ?: throw ReauthRequiredError(subject, "missing_credentials")
        if (current.quarantinedAt != null) {
            throw ReauthRequiredError(subject, current.quarantineReason ?: "quarantined")
        }
        if (!force && current.expiresAt - now() >= protocol.refreshMarginMs) {
            return RefreshResult(current, false)
        }
        try {
            val next = oauth.refresh(current)
            val swapped = store.compareAndSwap(subject, current.version, next)
            if (swapped.ok) return RefreshResult(next, true)
            val winner = swapped.current
            if (winner?.quarantinedAt != null) {
                throw ReauthRequiredError(subject, winner.quarantineReason ?: "quarantined")
            }
            if (winner != null) return RefreshResult(winner, true)
            throw ReauthRequiredError(subject, "credentials_deleted_during_refresh")
        } catch (failure: TokenEndpointFailure) {
            if (failure.terminal) {
                val winner = quarantine(subject, current, failure.errorCode ?: "http_${failure.status}")
                return RefreshResult(winner, true)
            }
            throw TokenRefreshError("Token refresh failed (${failure.status}).", sanitizedLifecycleCause(failure))
        }
    }

    private suspend fun inFlight(subject: String, force: Boolean): RefreshResult {
        val selected = registry.mutex.withLock {
            val existing = registry.flights[subject]
            if (existing != null) return@withLock Pair(existing, false)
            val deferred = CompletableDeferred<RefreshResult>()
            val created = RefreshFlight(force, deferred)
            registry.flights[subject] = created
            Pair(created, true)
        }
        val flight = selected.first
        if (!selected.second) {
            val result = flight.deferred.await()
            return if (!force || flight.force || result.refreshed) result else inFlight(subject, true)
        }

        val leader = flight.deferred as CompletableDeferred<RefreshResult>
        try {
            val result = refreshOne(subject, force)
            removeFlight(subject, flight)
            leader.complete(result)
            return result
        } catch (cause: Throwable) {
            removeFlight(subject, flight)
            leader.completeExceptionally(cause)
            throw cause
        }
    }

    private suspend fun removeFlight(subject: String, flight: RefreshFlight) {
        withContext(NonCancellable) {
            registry.mutex.withLock {
                if (registry.flights[subject]?.deferred === flight.deferred) registry.flights.remove(subject)
            }
        }
    }

    private fun requireSubject(subject: String) {
        require(subject.isNotBlank()) { "subject must be a nonempty server-derived identifier." }
    }

    private companion object {
        val registryLock = Any()
        val registries = mutableListOf<Pair<WeakReference<CredentialStore>, FlightRegistry>>()

        fun registryFor(store: CredentialStore): FlightRegistry = synchronized(registryLock) {
            registries.removeAll { it.first.get() == null }
            registries.firstOrNull { it.first.get() === store }?.second ?: FlightRegistry().also {
                registries += WeakReference(store) to it
            }
        }
    }
}

private fun sanitizedLifecycleCause(cause: Throwable): Throwable =
    IllegalStateException(redact(cause.message ?: cause::class.simpleName.orEmpty()))
