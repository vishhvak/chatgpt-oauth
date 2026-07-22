"""POSIX encrypted file storage with AES-256-GCM, atomic replacement, and CAS."""

from __future__ import annotations

import asyncio
import base64
import binascii
import fcntl
import hmac
import json
import os
import secrets
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import asdict, replace
from pathlib import Path
from typing import cast

from ..types import CompareAndSwapResult, StoreError, TokenSet

_SBOX = (
    0x63,
    0x7C,
    0x77,
    0x7B,
    0xF2,
    0x6B,
    0x6F,
    0xC5,
    0x30,
    0x01,
    0x67,
    0x2B,
    0xFE,
    0xD7,
    0xAB,
    0x76,
    0xCA,
    0x82,
    0xC9,
    0x7D,
    0xFA,
    0x59,
    0x47,
    0xF0,
    0xAD,
    0xD4,
    0xA2,
    0xAF,
    0x9C,
    0xA4,
    0x72,
    0xC0,
    0xB7,
    0xFD,
    0x93,
    0x26,
    0x36,
    0x3F,
    0xF7,
    0xCC,
    0x34,
    0xA5,
    0xE5,
    0xF1,
    0x71,
    0xD8,
    0x31,
    0x15,
    0x04,
    0xC7,
    0x23,
    0xC3,
    0x18,
    0x96,
    0x05,
    0x9A,
    0x07,
    0x12,
    0x80,
    0xE2,
    0xEB,
    0x27,
    0xB2,
    0x75,
    0x09,
    0x83,
    0x2C,
    0x1A,
    0x1B,
    0x6E,
    0x5A,
    0xA0,
    0x52,
    0x3B,
    0xD6,
    0xB3,
    0x29,
    0xE3,
    0x2F,
    0x84,
    0x53,
    0xD1,
    0x00,
    0xED,
    0x20,
    0xFC,
    0xB1,
    0x5B,
    0x6A,
    0xCB,
    0xBE,
    0x39,
    0x4A,
    0x4C,
    0x58,
    0xCF,
    0xD0,
    0xEF,
    0xAA,
    0xFB,
    0x43,
    0x4D,
    0x33,
    0x85,
    0x45,
    0xF9,
    0x02,
    0x7F,
    0x50,
    0x3C,
    0x9F,
    0xA8,
    0x51,
    0xA3,
    0x40,
    0x8F,
    0x92,
    0x9D,
    0x38,
    0xF5,
    0xBC,
    0xB6,
    0xDA,
    0x21,
    0x10,
    0xFF,
    0xF3,
    0xD2,
    0xCD,
    0x0C,
    0x13,
    0xEC,
    0x5F,
    0x97,
    0x44,
    0x17,
    0xC4,
    0xA7,
    0x7E,
    0x3D,
    0x64,
    0x5D,
    0x19,
    0x73,
    0x60,
    0x81,
    0x4F,
    0xDC,
    0x22,
    0x2A,
    0x90,
    0x88,
    0x46,
    0xEE,
    0xB8,
    0x14,
    0xDE,
    0x5E,
    0x0B,
    0xDB,
    0xE0,
    0x32,
    0x3A,
    0x0A,
    0x49,
    0x06,
    0x24,
    0x5C,
    0xC2,
    0xD3,
    0xAC,
    0x62,
    0x91,
    0x95,
    0xE4,
    0x79,
    0xE7,
    0xC8,
    0x37,
    0x6D,
    0x8D,
    0xD5,
    0x4E,
    0xA9,
    0x6C,
    0x56,
    0xF4,
    0xEA,
    0x65,
    0x7A,
    0xAE,
    0x08,
    0xBA,
    0x78,
    0x25,
    0x2E,
    0x1C,
    0xA6,
    0xB4,
    0xC6,
    0xE8,
    0xDD,
    0x74,
    0x1F,
    0x4B,
    0xBD,
    0x8B,
    0x8A,
    0x70,
    0x3E,
    0xB5,
    0x66,
    0x48,
    0x03,
    0xF6,
    0x0E,
    0x61,
    0x35,
    0x57,
    0xB9,
    0x86,
    0xC1,
    0x1D,
    0x9E,
    0xE1,
    0xF8,
    0x98,
    0x11,
    0x69,
    0xD9,
    0x8E,
    0x94,
    0x9B,
    0x1E,
    0x87,
    0xE9,
    0xCE,
    0x55,
    0x28,
    0xDF,
    0x8C,
    0xA1,
    0x89,
    0x0D,
    0xBF,
    0xE6,
    0x42,
    0x68,
    0x41,
    0x99,
    0x2D,
    0x0F,
    0xB0,
    0x54,
    0xBB,
    0x16,
)
_RCON = (0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36)


def _rot(word: int) -> int:
    return ((word << 8) & 0xFFFFFFFF) | (word >> 24)


def _sub(word: int) -> int:
    return sum(_SBOX[(word >> shift) & 0xFF] << shift for shift in (24, 16, 8, 0))


def _expand_key(key: bytes) -> tuple[int, ...]:
    if len(key) != 32:
        raise ValueError("AES-256 needs a 32-byte key")
    words = [int.from_bytes(key[index : index + 4], "big") for index in range(0, 32, 4)]
    for index in range(8, 60):
        temporary = words[index - 1]
        if index % 8 == 0:
            temporary = _sub(_rot(temporary)) ^ (_RCON[index // 8] << 24)
        elif index % 8 == 4:
            temporary = _sub(temporary)
        words.append(words[index - 8] ^ temporary)
    return tuple(words)


def _xtime(value: int) -> int:
    return ((value << 1) ^ (0x1B if value & 0x80 else 0)) & 0xFF


def _encrypt_block(block: bytes, schedule: tuple[int, ...]) -> bytes:
    state = list(block)

    def add_round_key(round_index: int) -> None:
        key = b"".join(
            word.to_bytes(4, "big") for word in schedule[round_index * 4 : round_index * 4 + 4]
        )
        for index in range(16):
            state[index] ^= key[index]

    add_round_key(0)
    for round_index in range(1, 15):
        state[:] = [_SBOX[value] for value in state]
        state[:] = [
            state[index] for index in (0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11)
        ]
        if round_index != 14:
            for column in range(4):
                offset = column * 4
                a, b, c, d = state[offset : offset + 4]
                total = a ^ b ^ c ^ d
                state[offset] ^= total ^ _xtime(a ^ b)
                state[offset + 1] ^= total ^ _xtime(b ^ c)
                state[offset + 2] ^= total ^ _xtime(c ^ d)
                state[offset + 3] ^= total ^ _xtime(d ^ a)
        add_round_key(round_index)
    return bytes(state)


def _multiply(left: int, right: int) -> int:
    product = 0
    value = left
    for bit in range(128):
        if right & (1 << (127 - bit)):
            product ^= value
        value = (value >> 1) ^ (0xE1000000000000000000000000000000 if value & 1 else 0)
    return product


def _ghash(hash_key: bytes, ciphertext: bytes) -> bytes:
    accumulator = 0
    h_value = int.from_bytes(hash_key, "big")
    padded = ciphertext + b"\0" * (-len(ciphertext) % 16)
    lengths = (0).to_bytes(8, "big") + (len(ciphertext) * 8).to_bytes(8, "big")
    for offset in range(0, len(padded + lengths), 16):
        block = (padded + lengths)[offset : offset + 16]
        accumulator = _multiply(accumulator ^ int.from_bytes(block, "big"), h_value)
    return accumulator.to_bytes(16, "big")


def _counter_crypt(value: bytes, schedule: tuple[int, ...], iv: bytes) -> bytes:
    output = bytearray()
    counter = 1
    for offset in range(0, len(value), 16):
        counter = (counter + 1) & 0xFFFFFFFF
        key_stream = _encrypt_block(iv + counter.to_bytes(4, "big"), schedule)
        chunk = value[offset : offset + 16]
        output.extend(left ^ right for left, right in zip(chunk, key_stream, strict=False))
    return bytes(output)


def _encrypt(plaintext: bytes, key: bytes) -> str:
    iv = secrets.token_bytes(12)
    schedule = _expand_key(key)
    ciphertext = _counter_crypt(plaintext, schedule, iv)
    hash_key = _encrypt_block(b"\0" * 16, schedule)
    tag = bytes(
        left ^ right
        for left, right in zip(
            _encrypt_block(iv + b"\0\0\0\1", schedule),
            _ghash(hash_key, ciphertext),
            strict=True,
        )
    )
    return ".".join(base64.b64encode(part).decode() for part in (iv, tag, ciphertext))


def _decrypt(envelope: str, key: bytes) -> bytes:
    try:
        fields = envelope.split(".")
        if len(fields) != 3:
            raise ValueError
        iv, tag, ciphertext = (base64.b64decode(field, validate=True) for field in fields)
        if len(iv) != 12 or len(tag) != 16:
            raise ValueError
        schedule = _expand_key(key)
        hash_key = _encrypt_block(b"\0" * 16, schedule)
        expected = bytes(
            left ^ right
            for left, right in zip(
                _encrypt_block(iv + b"\0\0\0\1", schedule),
                _ghash(hash_key, ciphertext),
                strict=True,
            )
        )
        if not hmac.compare_digest(tag, expected):
            raise ValueError
        return _counter_crypt(ciphertext, schedule, iv)
    except (binascii.Error, ValueError) as error:
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
        if not subject:
            raise ValueError("subject must be nonempty")
        token = await asyncio.to_thread(lambda: self._read().get(subject))
        return replace(token) if token is not None else None

    async def compare_and_swap(
        self, subject: str, expected_version: int, next_token: TokenSet
    ) -> CompareAndSwapResult:
        """Locks, compares, and atomically replaces one subject's generation."""
        if not subject:
            raise ValueError("subject must be nonempty")

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
        if not subject:
            raise ValueError("subject must be nonempty")

        def operation() -> None:
            with self._locked():
                records = self._read()
                records.pop(subject, None)
                self._write(records)

        await asyncio.to_thread(operation)


async def create_file_credential_store(
    directory: str | Path,
    *,
    key_file: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> FileCredentialStore:
    """Creates an AES-256-GCM file store with strict POSIX modes."""
    return await FileCredentialStore.create(directory, key_file=key_file, env=env)
