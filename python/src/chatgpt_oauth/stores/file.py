"""POSIX encrypted file storage: AES-256-GCM (OpenSSL-backed), atomic replacement, and CAS."""

from __future__ import annotations

import asyncio
import base64
import binascii
import fcntl
import json
import os
import secrets
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import asdict, replace
from pathlib import Path
from typing import cast

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..types import CompareAndSwapResult, StoreError, TokenSet, validate_subject

_TAG_LENGTH = 16


def _encrypt(plaintext: bytes, key: bytes) -> str:
    nonce = secrets.token_bytes(12)
    sealed = AESGCM(key).encrypt(nonce, plaintext, None)
    ciphertext, tag = sealed[:-_TAG_LENGTH], sealed[-_TAG_LENGTH:]
    return ".".join(base64.b64encode(part).decode() for part in (nonce, tag, ciphertext))


def _decrypt(envelope: str, key: bytes) -> bytes:
    try:
        fields = envelope.split(".")
        if len(fields) != 3:
            raise ValueError
        nonce, tag, ciphertext = (base64.b64decode(field, validate=True) for field in fields)
        if len(nonce) != 12 or len(tag) != _TAG_LENGTH:
            raise ValueError
        return AESGCM(key).decrypt(nonce, ciphertext + tag, None)
    except (binascii.Error, ValueError, InvalidTag) as error:
        raise StoreError("Credential data failed authentication or is malformed.") from error


def _parse_key(value: str) -> bytes:
    try:
        if len(value) == 64 and all(character in "0123456789abcdefABCDEF" for character in value):
            decoded = bytes.fromhex(value)
        else:
            normalized = value.replace("-", "+").replace("_", "/")
            decoded = base64.b64decode(normalized + "=" * (-len(normalized) % 4), validate=True)
    except (binascii.Error, ValueError) as error:
        raise StoreError("CHATGPT_OAUTH_KEY must encode exactly 32 bytes.") from error
    if len(decoded) != 32:
        raise StoreError("CHATGPT_OAUTH_KEY must encode exactly 32 bytes.")
    return decoded


def _token_from_json(value: object) -> TokenSet:
    if not isinstance(value, dict):
        raise ValueError
    data = cast(dict[str, object], value)
    access = data.get("access_token")
    refresh = data.get("refresh_token")
    expires = data.get("expires_at")
    version = data.get("version")
    if not isinstance(access, str) or not isinstance(refresh, str):
        raise ValueError
    if not isinstance(expires, int) or not isinstance(version, int):
        raise ValueError

    def optional_str(name: str) -> str | None:
        candidate = data.get(name)
        if candidate is not None and not isinstance(candidate, str):
            raise ValueError
        return candidate

    quarantined = data.get("quarantined_at")
    if quarantined is not None and not isinstance(quarantined, int):
        raise ValueError
    return TokenSet(
        access_token=access,
        refresh_token=refresh,
        expires_at=expires,
        version=version,
        id_token=optional_str("id_token"),
        account_id=optional_str("account_id"),
        plan_type=optional_str("plan_type"),
        email=optional_str("email"),
        quarantined_at=quarantined,
        quarantine_reason=optional_str("quarantine_reason"),
    )


class FileCredentialStore:
    """Persists subject-keyed credentials in one authenticated encrypted file."""

    def __init__(self, directory: Path, key: bytes, key_file: Path) -> None:
        self._directory = directory
        self._key = key
        self._key_file = key_file
        self._data_file = directory / "credentials.enc"
        self._lock_file = directory / "credentials.lock"

    @classmethod
    async def create(
        cls,
        directory: str | Path,
        *,
        key_file: str | Path | None = None,
        env: Mapping[str, str] | None = None,
    ) -> FileCredentialStore:
        """Creates a mode-hardened store and resolves its 32-byte key."""
        path = Path(directory)
        resolved_key_file = Path(key_file) if key_file is not None else path / "credentials.key"
        environment = env if env is not None else os.environ
        key = await asyncio.to_thread(cls._initialize, path, resolved_key_file, environment)
        return cls(path, key, resolved_key_file)

    @staticmethod
    def _initialize(directory: Path, key_file: Path, env: Mapping[str, str]) -> bytes:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.chmod(0o700)
        override = env.get("CHATGPT_OAUTH_KEY")
        if override is not None:
            return _parse_key(override)
        try:
            key = key_file.read_bytes()
            if len(key) != 32:
                raise StoreError("The credential key file is malformed.")
            key_file.chmod(0o600)
            return key
        except FileNotFoundError:
            pass
        key = secrets.token_bytes(32)
        key_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            descriptor = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as error:
            deadline = time.monotonic() + 1
            while True:
                winner = key_file.read_bytes()
                if len(winner) == 32:
                    return winner
                if len(winner) > 32 or time.monotonic() >= deadline:
                    raise StoreError("The credential key file is malformed.") from error
                time.sleep(0.01)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(key)
            handle.flush()
            os.fsync(handle.fileno())
        FileCredentialStore._sync_directory(directory)
        return key

    @staticmethod
    def _sync_directory(directory: Path) -> None:
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        except OSError:
            pass
        finally:
            os.close(descriptor)

    @contextmanager
    def _locked(self) -> Iterator[None]:
        descriptor = os.open(self._lock_file, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _read(self) -> dict[str, TokenSet]:
        try:
            encrypted = self._data_file.read_text()
        except FileNotFoundError:
            return {}
        try:
            parsed = cast(object, json.loads(_decrypt(encrypted, self._key).decode()))
            if not isinstance(parsed, dict):
                raise ValueError
            records = cast(dict[str, object], parsed)
            return {subject: _token_from_json(value) for subject, value in records.items()}
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            raise StoreError("Credential data failed authentication or is malformed.") from error

    def _write(self, records: Mapping[str, TokenSet]) -> None:
        plaintext = json.dumps(
            {subject: asdict(token) for subject, token in records.items()},
            separators=(",", ":"),
        ).encode()
        temporary = self._data_file.with_name(
            f"{self._data_file.name}.tmp.{os.getpid()}.{secrets.token_hex(12)}"
        )
        descriptor: int | None = None
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as handle:
                descriptor = None
                handle.write(_encrypt(plaintext, self._key))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self._data_file)
            self._data_file.chmod(0o600)
            self._sync_directory(self._directory)
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass

    async def load(self, subject: str) -> TokenSet | None:
        """Loads credentials for one explicit subject."""
        validate_subject(subject)
        token = await asyncio.to_thread(lambda: self._read().get(subject))
        return replace(token) if token is not None else None

    async def compare_and_swap(
        self, subject: str, expected_version: int, next_token: TokenSet
    ) -> CompareAndSwapResult:
        """Locks, compares, and atomically replaces one subject's generation."""
        validate_subject(subject)

        def operation() -> CompareAndSwapResult:
            with self._locked():
                records = self._read()
                current = records.get(subject)
                if (current.version if current else 0) != expected_version:
                    return CompareAndSwapResult(False, replace(current) if current else None)
                stored = replace(next_token, version=expected_version + 1)
                records[subject] = stored
                self._write(records)
                return CompareAndSwapResult(True, replace(stored))

        return await asyncio.to_thread(operation)

    async def delete(self, subject: str) -> None:
        """Locks and deletes credentials for one explicit subject."""
        validate_subject(subject)

        def operation() -> None:
            with self._locked():
                records = self._read()
                records.pop(subject, None)
                self._write(records)

        await asyncio.to_thread(operation)


async def create_file_store(
    directory: str | Path,
    *,
    key_file: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> FileCredentialStore:
    """Creates an AES-256-GCM file store with strict POSIX modes."""
    return await FileCredentialStore.create(directory, key_file=key_file, env=env)
