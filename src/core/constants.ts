/** Owns every externally verified protocol constant so drift is visible in one review. */
export const PROTOCOL = Object.freeze({
  CLIENT_ID: "app_EMoamEEZ73f0CkXaXp7hrann",
  AUTHORIZE_URL: "https://auth.openai.com/oauth/authorize",
  TOKEN_URL: "https://auth.openai.com/oauth/token",
  SCOPES: "openid profile email offline_access",
  LOOPBACK_PORT: 1455,
  LOOPBACK_REDIRECT: "http://localhost:1455/auth/callback",
  EXTRA_AUTH_PARAMS: Object.freeze({
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  }),
  RESPONSES_URL: "https://chatgpt.com/backend-api/codex/responses",
  DEVICE_USERCODE_URL: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  DEVICE_POLL_URL: "https://auth.openai.com/api/accounts/deviceauth/token",
  DEVICE_VERIFY_URL: "https://auth.openai.com/codex/device",
  DEVICE_REDIRECT_URL: "https://auth.openai.com/deviceauth/callback",
  REFRESH_MARGIN_MS: 120_000,
});

export type ProtocolConfig = typeof PROTOCOL;
export type ProtocolOverrides = Partial<Omit<ProtocolConfig, "EXTRA_AUTH_PARAMS">> & {
  EXTRA_AUTH_PARAMS?: Readonly<Record<string, string>>;
};

export function protocolWith(overrides: ProtocolOverrides = {}): ProtocolConfig {
  return Object.freeze({ ...PROTOCOL, ...overrides, EXTRA_AUTH_PARAMS: Object.freeze({
    ...PROTOCOL.EXTRA_AUTH_PARAMS,
    ...overrides.EXTRA_AUTH_PARAMS,
  }) }) as ProtocolConfig;
}
