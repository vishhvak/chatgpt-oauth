"""Ephemeral subject-keyed credential storage for tests and local development."""

import asyncio
from collections.abc import Mapping
from dataclasses import replace

from ..types import CompareAndSwapResult, TokenSet


class MemoryCredentialStore:
    """Stores cloned credentials in memory with atomic subject-scoped CAS."""

    def __init__(self, initial: Mapping[str, TokenSet] | None = None) -> None:
        self._records = dict(initial or {})
        self._lock = asyncio.Lock()

    async def load(self, subject: str) -> TokenSet | None:
        """Loads credentials for one explicit subject."""
        if not subject:
            raise ValueError("subject must be nonempty")
        token = self._records.get(subject)
        return replace(token) if token is not None else None

    async def compare_and_swap(
        self, subject: str, expected_version: int, next_token: TokenSet
    ) -> CompareAndSwapResult:
        """Stores expected-version-plus-one or returns the current winner."""
        if not subject:
            raise ValueError("subject must be nonempty")
        async with self._lock:
            current = self._records.get(subject)
            if (current.version if current else 0) != expected_version:
                return CompareAndSwapResult(False, replace(current) if current else None)
            stored = replace(next_token, version=expected_version + 1)
            self._records[subject] = stored
            return CompareAndSwapResult(True, replace(stored))

    async def delete(self, subject: str) -> None:
        """Deletes credentials for one explicit subject."""
        if not subject:
            raise ValueError("subject must be nonempty")
        async with self._lock:
            self._records.pop(subject, None)


def create_memory_store(
    initial: Mapping[str, TokenSet] | None = None,
) -> MemoryCredentialStore:
    """Creates a deliberately ephemeral subject-keyed credential store."""
    return MemoryCredentialStore(initial)
