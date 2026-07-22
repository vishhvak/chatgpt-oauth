"""Secret scrubbing for all untrusted text exposed through public failures."""

import re

_REDACTED = "[REDACTED]"
_BEARER = re.compile(r"\bBearer\s+[^\s,;\"']+", re.IGNORECASE)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
_JSON_DOUBLE = re.compile(
    r'("(?:access_?token|refresh_?token|id_?token|authorization)"\s*:\s*")'
    r'((?:\\.|[^"\\])*(?:\\(?=$))?)("|$)',
    re.IGNORECASE,
)
_JSON_SINGLE = re.compile(
    r"('(?:access_?token|refresh_?token|id_?token|authorization)'\s*:\s*')"
    r"((?:\\.|[^'\\])*(?:\\(?=$))?)('|$)",
    re.IGNORECASE,
)
_FORM = re.compile(
    r"\b(access_?token|refresh_?token|id_?token|authorization)=([^&\s]+)", re.IGNORECASE
)


def redact(value: str) -> str:
    """Scrubs bearer, JWT, JSON, and form credentials from text."""
    value = _BEARER.sub(f"Bearer {_REDACTED}", value)
    value = _JWT.sub(_REDACTED, value)
    value = _JSON_DOUBLE.sub(rf"\1{_REDACTED}\3", value)
    value = _JSON_SINGLE.sub(rf"\1{_REDACTED}\3", value)
    return _FORM.sub(rf"\1={_REDACTED}", value)
