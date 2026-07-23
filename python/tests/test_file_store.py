import base64
import os
from pathlib import Path

import pytest

from chatgpt_oauth import StoreError, TokenSet, create_file_store
from chatgpt_oauth.stores.file import _decrypt


@pytest.mark.asyncio
async def test_encrypted_roundtrip_modes_cas_and_tamper(tmp_path: Path) -> None:
    directory = tmp_path / "credentials"
    store = await create_file_store(directory, env={})
    token = TokenSet("access-secret", "refresh-secret", 1000, 99)
    saved = await store.compare_and_swap("subject", 0, token)
    assert saved.ok and saved.current is not None and saved.current.version == 1
    loaded = await store.load("subject")
    assert loaded is not None and loaded.access_token == "access-secret"
    assert (directory.stat().st_mode & 0o777) == 0o700
    assert ((directory / "credentials.key").stat().st_mode & 0o777) == 0o600
    assert ((directory / "credentials.enc").stat().st_mode & 0o777) == 0o600
    envelope = (directory / "credentials.enc").read_text()
    assert "access-secret" not in envelope
    fields = envelope.split(".")
    tag = bytearray(base64.b64decode(fields[1]))
    tag[0] ^= 1
    fields[1] = base64.b64encode(tag).decode()
    (directory / "credentials.enc").write_text(".".join(fields))
    os.chmod(directory / "credentials.enc", 0o600)
    with pytest.raises(StoreError):
        await store.load("subject")


@pytest.mark.asyncio
async def test_environment_key_encodings_and_no_key_file(tmp_path: Path) -> None:
    key = bytes(range(32))
    for name, encoded in (
        ("hex", key.hex()),
        ("base64", base64.b64encode(key).decode()),
        ("base64url", base64.urlsafe_b64encode(key).rstrip(b"=").decode()),
    ):
        directory = tmp_path / name
        await create_file_store(directory, env={"CHATGPT_OAUTH_KEY": encoded})
        assert not (directory / "credentials.key").exists()


def test_aes_256_gcm_empty_plaintext_nist_vector() -> None:
    key = bytes(32)
    iv = bytes(12)
    tag = bytes.fromhex("530f8afbc74536b9a963b4f1c4cb738b")
    envelope = ".".join(base64.b64encode(part).decode() for part in (iv, tag, b""))
    assert _decrypt(envelope, key) == b""


def test_aes_256_gcm_block_nist_vector() -> None:
    key = bytes(32)
    iv = bytes(12)
    ciphertext = bytes.fromhex("cea7403d4d606b6e074ec5d3baf39d18")
    tag = bytes.fromhex("d0d1c8a799996bf0265b98b5d48ab919")
    envelope = ".".join(base64.b64encode(part).decode() for part in (iv, tag, ciphertext))
    assert _decrypt(envelope, key) == bytes(16)
