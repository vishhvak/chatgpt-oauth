import Foundation

/// Stores subject-keyed credentials ephemerally for tests and local development.
public actor MemoryCredentialStore: CredentialStore {
    private var records: [String: TokenSet]

    /// Creates a memory store containing independent value copies of the supplied records.
    public init(initial: [String: TokenSet] = [:]) {
        records = initial
    }

    /// Loads credentials for exactly one explicit subject.
    public func load(subject: String) async throws -> TokenSet? {
        try requireSubject(subject)
        return records[subject]
    }

    /// Replaces one subject only when its current version matches, returning the winning value otherwise.
    public func compareAndSwap(
        subject: String,
        expectedVersion: Int,
        next: TokenSet
    ) async throws -> CompareAndSwapResult {
        try requireSubject(subject)
        let current = records[subject]
        guard (current?.version ?? 0) == expectedVersion else {
            return CompareAndSwapResult(succeeded: false, current: current)
        }

        var stored = next
        stored.version = expectedVersion + 1
        records[subject] = stored
        return CompareAndSwapResult(succeeded: true, current: stored)
    }

    /// Deletes credentials for exactly one explicit subject.
    public func delete(subject: String) async throws {
        try requireSubject(subject)
        records.removeValue(forKey: subject)
    }

    private func requireSubject(_ subject: String) throws {
        guard !subject.isEmpty else {
            throw ChatGPTOAuthError.store(message: "Credential subject must not be empty.")
        }
    }
}
