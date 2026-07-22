"""Fixed protocol constants and test-only endpoint overrides."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType


@dataclass(frozen=True, slots=True)
class ProtocolConfig:
    """Holds externally verified OAuth and backend protocol constants."""

    client_id: str = "app_EMoamEEZ73f0CkXaXp7hrann"
    authorize_url: str = "https://auth.openai.com/oauth/authorize"
    token_url: str = "https://auth.openai.com/oauth/token"
    scopes: str = "openid profile email offline_access"
    loopback_port: int = 1455
    loopback_redirect: str = "http://localhost:1455/auth/callback"
    responses_url: str = "https://chatgpt.com/backend-api/codex/responses"
    # Required query value on codex backend endpoints; requests without it are rejected with 400.
    client_version: str = "0.144.6"
    device_usercode_url: str = "https://auth.openai.com/api/accounts/deviceauth/usercode"
    device_poll_url: str = "https://auth.openai.com/api/accounts/deviceauth/token"
    device_verify_url: str = "https://auth.openai.com/codex/device"
    device_redirect_url: str = "https://auth.openai.com/deviceauth/callback"
    refresh_margin_ms: int = 120_000
    extra_auth_params: Mapping[str, str] = field(
        default_factory=lambda: MappingProxyType(
            {"id_token_add_organizations": "true", "codex_cli_simplified_flow": "true"}
        )
    )


PROTOCOL = ProtocolConfig()
