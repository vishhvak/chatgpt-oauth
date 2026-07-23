import re

import pytest

from chatgpt_oauth import StateMismatchError
from chatgpt_oauth.pkce import assert_state, create_pkce, pkce_challenge


def test_known_s256_vector_and_generated_lengths() -> None:
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assert pkce_challenge(verifier) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    generated_verifier, challenge, state = create_pkce()
    assert re.fullmatch(r"[A-Za-z0-9_-]{86}", generated_verifier)
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", challenge)
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", state)


def test_state_mismatch_is_typed() -> None:
    assert_state("same", "same")
    with pytest.raises(StateMismatchError):
        assert_state("same", "different")
