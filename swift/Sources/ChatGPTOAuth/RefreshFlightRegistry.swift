import Foundation

/// One refresh generation in flight for a `(store, subject)` pair.
struct RefreshResult: Sendable {
    let token: TokenSet
    let refreshed: Bool
}

struct RefreshFlight: Sendable {
    let id: UUID
    let force: Bool
    let task: Task<RefreshResult, Error>
}

/// Process-wide singleflight registry keyed by credential-store identity.
///
/// The protocol scopes singleflight to `(store instance, subject)`, not to one `AuthSession`. An app
/// that builds a session per request, or one for a foreground path and another for a background
/// task, over a single shared store must still collapse concurrent refreshes into one network call —
/// otherwise a rotating refresh token can be spent twice, and although CAS keeps the stored record
/// consistent, the second refresh is a wasted (and potentially rejected) round trip. The other three
/// ports all key their registry by the store: TypeScript a `WeakMap`, Kotlin a weak-referenced
/// registry list, Python a `WeakKeyDictionary`.
///
/// An entry exists only while at least one flight is running for that store, and every flight
/// clears itself on both the success and failure paths, so the map needs no separate sweep. The
/// owning `AuthSession` retains the anchor object for its whole lifetime, so a key can never be
/// reused by a different store while its entry is live. Only the identity crosses the actor
/// boundary — `ObjectIdentifier` is `Sendable`, the object itself is not and stays put.
actor RefreshFlightRegistry {
    static let shared = RefreshFlightRegistry()

    private var entries: [ObjectIdentifier: [String: RefreshFlight]] = [:]

    /// Returns the live flight for `subject`, installing one from `make` when there is none.
    ///
    /// Lookup and insert happen in a single actor-isolated step with no suspension between them, so
    /// two callers racing for the same subject cannot both install a flight.
    func flight(
        key: ObjectIdentifier,
        subject: String,
        force: Bool,
        make: (UUID) -> Task<RefreshResult, Error>
    ) -> (flight: RefreshFlight, existed: Bool) {
        if let existing = entries[key]?[subject] {
            return (existing, true)
        }
        // One id: the task clears itself by the same id the entry is stored under.
        let id = UUID()
        let created = RefreshFlight(id: id, force: force, task: make(id))
        entries[key, default: [:]][subject] = created
        return (created, false)
    }

    /// Removes a finished flight, but only if it is still the one that was installed.
    func clear(key: ObjectIdentifier, subject: String, id: UUID) {
        guard entries[key]?[subject]?.id == id else { return }
        entries[key]?.removeValue(forKey: subject)
        if entries[key]?.isEmpty == true { entries.removeValue(forKey: key) }
    }

    /// Test hook: the number of live flights recorded for a store.
    func flightCount(key: ObjectIdentifier) -> Int {
        entries[key]?.count ?? 0
    }
}
