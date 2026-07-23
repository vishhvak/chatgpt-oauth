import Foundation
import CryptoKit
import Darwin
import Security

private actor KeychainServiceLocks {
    static let shared = KeychainServiceLocks()
    private var held: Set<String> = []
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]

    func acquire(service: String) async {
        guard held.contains(service) else {
            held.insert(service)
            return
        }
        await withCheckedContinuation { waiters[service, default: []].append($0) }
    }

    func release(service: String) {
        if var queued = waiters[service], !queued.isEmpty {
            let next = queued.removeFirst()
            waiters[service] = queued.isEmpty ? nil : queued
            next.resume()
        } else {
            held.remove(service)
        }
    }
}

/// Stores subject-keyed credentials in this device's Keychain with process-safe compare-and-swap updates.
public actor KeychainCredentialStore: CredentialStore {
    private let service: String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    /// Creates a Keychain store isolated by the supplied service identifier.
    public init(service: String = "com.openai.chatgpt-oauth") {
        self.service = service
    }

    /// Loads credentials for exactly one explicit subject.
    public func load(subject: String) async throws -> TokenSet? {
        try requireSubject(subject)
        return try read(subject: subject)
    }

    /// Replaces one subject only when its current version matches, returning the winning value otherwise.
    public func compareAndSwap(
        subject: String,
        expectedVersion: Int,
        next: TokenSet
    ) async throws -> CompareAndSwapResult {
        try requireSubject(subject)
        await KeychainServiceLocks.shared.acquire(service: service)
        do {
            let result = try withExclusiveLock {
                let current = try read(subject: subject)
                guard (current?.version ?? 0) == expectedVersion else {
                    return CompareAndSwapResult(succeeded: false, current: current)
                }

                var stored = next
                stored.version = expectedVersion + 1
                try write(stored, subject: subject, replacingExisting: current != nil)
                return CompareAndSwapResult(succeeded: true, current: stored)
            }
            await KeychainServiceLocks.shared.release(service: service)
            return result
        } catch {
            await KeychainServiceLocks.shared.release(service: service)
            throw error
        }
    }

    /// Deletes credentials for exactly one explicit subject.
    public func delete(subject: String) async throws {
        try requireSubject(subject)
        await KeychainServiceLocks.shared.acquire(service: service)
        do {
            try withExclusiveLock {
                let status = SecItemDelete(baseQuery(subject: subject) as CFDictionary)
                guard status == errSecSuccess || status == errSecItemNotFound else {
                    throw storeError(operation: "delete", status: status)
                }
            }
            await KeychainServiceLocks.shared.release(service: service)
        } catch {
            await KeychainServiceLocks.shared.release(service: service)
            throw error
        }
    }

    private func read(subject: String) throws -> TokenSet? {
        var query = baseQuery(subject: subject)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw storeError(operation: "load", status: status)
        }
        do {
            return try decoder.decode(TokenSet.self, from: data)
        } catch {
            throw ChatGPTOAuthError.store(message: "Keychain credentials could not be decoded.")
        }
    }

    private func write(_ token: TokenSet, subject: String, replacingExisting: Bool) throws {
        let data: Data
        do {
            data = try encoder.encode(token)
        } catch {
            throw ChatGPTOAuthError.store(message: "Keychain credentials could not be encoded.")
        }

        let status: OSStatus
        if replacingExisting {
            let attributes = [kSecValueData as String: data]
            status = SecItemUpdate(baseQuery(subject: subject) as CFDictionary, attributes as CFDictionary)
        } else {
            var query = baseQuery(subject: subject)
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(query as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw storeError(operation: "save", status: status)
        }
    }

    private func baseQuery(subject: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: subject,
        ]
    }

    private func storeError(operation: String, status: OSStatus) -> ChatGPTOAuthError {
        ChatGPTOAuthError.store(message: "Keychain \(operation) failed with status \(status).")
    }

    private func withExclusiveLock<T>(_ operation: () throws -> T) throws -> T {
        let directory = try lockDirectory()
        let digest = SHA256.hash(data: Data(service.utf8)).map { String(format: "%02x", $0) }.joined()
        let path = directory.appendingPathComponent("\(digest).lock").path
        let descriptor = Darwin.open(path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            throw ChatGPTOAuthError.store(message: "Keychain lock could not be opened.")
        }
        defer { Darwin.close(descriptor) }
        guard Darwin.fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
            throw ChatGPTOAuthError.store(message: "Keychain lock permissions could not be secured.")
        }
        while Darwin.lockf(descriptor, F_LOCK, 0) != 0 {
            if errno != EINTR {
                throw ChatGPTOAuthError.store(message: "Keychain lock could not be acquired.")
            }
        }
        defer { _ = Darwin.lockf(descriptor, F_ULOCK, 0) }
        return try operation()
    }

    private func lockDirectory() throws -> URL {
        guard let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            throw ChatGPTOAuthError.store(message: "Application Support is unavailable for Keychain locking.")
        }
        let directory = applicationSupport
            .appendingPathComponent("ChatGPTOAuth", isDirectory: true)
            .appendingPathComponent("KeychainLocks", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: 0o700)],
                ofItemAtPath: directory.path
            )
            return directory
        } catch {
            throw ChatGPTOAuthError.store(message: "Keychain lock directory could not be secured.")
        }
    }
}
