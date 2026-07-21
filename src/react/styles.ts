/** Holds the single scoped stylesheet injected by the default React shell. */
export const CHATGPT_AUTH_STYLES = `
.cgpt-root {
  --cgpt-bg: #ffffff;
  --cgpt-fg: #0d0d0d;
  --cgpt-border: rgba(13, 13, 13, 0.14);
  --cgpt-radius: 12px;
  --cgpt-accent: #0d8f72;
  --cgpt-muted: #666666;
  box-sizing: border-box;
  display: inline-flex;
  flex-direction: column;
  gap: 10px;
  max-width: 100%;
  color: var(--cgpt-fg);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  font-synthesis: none;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.cgpt-root *, .cgpt-root *::before, .cgpt-root *::after { box-sizing: border-box; }
.cgpt-theme-dark {
  --cgpt-bg: #171717;
  --cgpt-fg: #f7f7f8;
  --cgpt-border: rgba(255, 255, 255, 0.14);
  --cgpt-accent: #4bc8a9;
  --cgpt-muted: #aaa9a5;
}
@media (prefers-color-scheme: dark) {
  .cgpt-theme-auto {
    --cgpt-bg: #171717;
    --cgpt-fg: #f7f7f8;
    --cgpt-border: rgba(255, 255, 255, 0.14);
    --cgpt-accent: #4bc8a9;
    --cgpt-muted: #aaa9a5;
  }
}
.cgpt-status, .cgpt-action-stack { display: flex; min-width: 0; }
.cgpt-action-stack { align-items: stretch; flex-direction: column; gap: 8px; }
.cgpt-button, .cgpt-signout {
  align-items: center;
  appearance: none;
  background: var(--cgpt-bg);
  border: 0;
  color: var(--cgpt-fg);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-weight: 600;
  justify-content: center;
  min-height: 44px;
  text-decoration: none;
  user-select: none;
  transition-property: transform, background-color, box-shadow;
  transition-duration: 150ms;
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}
.cgpt-button {
  border-radius: var(--cgpt-radius);
  gap: 10px;
  padding: 0 16px 0 14px;
  box-shadow: 0 0 0 1px var(--cgpt-border), 0 1px 2px rgba(0,0,0,.06), 0 3px 8px rgba(0,0,0,.06);
  white-space: nowrap;
}
.cgpt-button:hover:not(:disabled) { background: color-mix(in srgb, var(--cgpt-bg) 94%, var(--cgpt-fg)); box-shadow: 0 0 0 1px var(--cgpt-border), 0 2px 4px rgba(0,0,0,.08), 0 5px 12px rgba(0,0,0,.07); }
.cgpt-button:active:not(:disabled), .cgpt-signout:active:not(:disabled) { transform: scale(.96); }
.cgpt-button:disabled { cursor: wait; opacity: .72; }
.cgpt-button:focus-visible, .cgpt-signout:focus-visible { outline: 3px solid var(--cgpt-accent); outline-offset: 3px; }
.cgpt-mark { flex: 0 0 auto; height: 21px; stroke-linecap: round; stroke-linejoin: round; width: 21px; }
.cgpt-spinner { animation: cgpt-spin 800ms linear infinite; border: 2px solid var(--cgpt-border); border-radius: 999px; border-top-color: var(--cgpt-fg); height: 17px; width: 17px; }
@keyframes cgpt-spin { to { transform: rotate(360deg); } }
.cgpt-connected {
  align-items: center;
  background: var(--cgpt-bg);
  border-radius: calc(var(--cgpt-radius) + 4px);
  box-shadow: 0 0 0 1px var(--cgpt-border), 0 2px 8px rgba(0,0,0,.05);
  display: flex;
  gap: 8px;
  min-height: 52px;
  padding: 4px;
}
.cgpt-identity { align-items: center; display: flex; gap: 9px; min-width: 0; padding: 4px 8px; }
.cgpt-identity-copy { display: flex; flex-direction: column; min-width: 0; }
.cgpt-identity-copy strong { font-size: 13px; font-weight: 600; line-height: 1.3; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cgpt-identity-copy span { color: var(--cgpt-muted); font-size: 12px; line-height: 1.35; text-transform: capitalize; }
.cgpt-signout { border-radius: var(--cgpt-radius); color: var(--cgpt-muted); gap: 6px; margin-inline-start: auto; padding: 0 11px 0 9px; }
.cgpt-signout:hover { background: color-mix(in srgb, var(--cgpt-bg) 91%, var(--cgpt-fg)); color: var(--cgpt-fg); }
.cgpt-signout svg { fill: none; height: 16px; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; width: 16px; }
.cgpt-error { color: #c93b32; font-size: 13px; line-height: 1.45; max-width: 38ch; overflow-wrap: break-word; text-wrap: pretty; }
.cgpt-theme-dark .cgpt-error { color: #ff8d85; }
.cgpt-disclaimer { color: var(--cgpt-muted); font-size: 12px; line-height: 1.5; margin: 0; max-width: 42ch; overflow-wrap: break-word; text-wrap: pretty; }
@media (prefers-color-scheme: dark) { .cgpt-theme-auto .cgpt-error { color: #ff8d85; } }
@media (prefers-reduced-motion: reduce) {
  .cgpt-button, .cgpt-signout { transition-duration: 0.01ms; }
  .cgpt-button:active:not(:disabled), .cgpt-signout:active:not(:disabled) { transform: none; }
  .cgpt-spinner { animation: none; }
}
`;
