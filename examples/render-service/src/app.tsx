/** Renders the local browser demo for the published React login component. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SignInWithChatGPT } from "chatgpt-oauth/react";

const endpoints = { session: "/auth/session", login: "/auth/login", logout: "/auth/logout" };
const initialTheme = new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : "light";

function Demo() {
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme);
  return (
    <main className={`demo-page demo-${theme}`}>
      <style>{PAGE_STYLES}</style>
      <section className="demo-card">
        <div className="demo-heading">
          <span className="demo-eyebrow">chatgpt-oauth</span>
          <h1>Bring your ChatGPT account</h1>
          <p>Sign in once. Your credentials stay encrypted on this server and are never exposed to the browser.</p>
        </div>
        <div aria-label="Color theme" className="demo-theme">
          {(["light", "dark"] as const).map((value) => (
            <button aria-pressed={theme === value} key={value} type="button" onClick={() => { setTheme(value); }}>
              {value}
            </button>
          ))}
        </div>
        <div className="demo-component">
          <SignInWithChatGPT endpoints={endpoints} theme={theme} />
        </div>
        <p className="demo-note">One application user maps to one isolated Codex process. This demo never pools identities or subscription access.</p>
      </section>
    </main>
  );
}

const root = document.getElementById("app");
if (root === null) throw new Error("Demo root is missing.");
createRoot(root).render(<Demo />);

const PAGE_STYLES = `
* { box-sizing: border-box; }
html, body, #app { min-height: 100%; margin: 0; }
body { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
button { font: inherit; }
.demo-page { align-items: center; display: flex; justify-content: center; min-height: 100vh; padding: 32px 20px; transition-property: background-color, color; transition-duration: 180ms; }
.demo-light { background: #f2f1ed; color: #171716; }
.demo-dark { background: #0f0f10; color: #f5f5f3; }
.demo-card { background: color-mix(in srgb, currentColor 3%, transparent); border-radius: 24px; box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 10%, transparent), 0 24px 70px rgba(0,0,0,.12); max-width: 500px; padding: 32px; width: 100%; }
.demo-heading { max-width: 42ch; }
.demo-eyebrow { color: #0d8f72; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.demo-heading h1 { font-size: clamp(28px, 7vw, 42px); letter-spacing: -.035em; line-height: 1.06; margin: 12px 0; text-wrap: balance; }
.demo-heading p, .demo-note { color: color-mix(in srgb, currentColor 66%, transparent); line-height: 1.55; text-wrap: pretty; }
.demo-heading p { font-size: 15px; margin: 0; }
.demo-theme { background: color-mix(in srgb, currentColor 6%, transparent); border-radius: 12px; display: inline-flex; gap: 3px; margin: 28px 0 18px; padding: 3px; }
.demo-theme button { background: transparent; border: 0; border-radius: 9px; color: inherit; cursor: pointer; min-height: 38px; padding: 0 14px; text-transform: capitalize; }
.demo-theme button[aria-pressed=true] { background: color-mix(in srgb, currentColor 10%, transparent); box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.demo-theme button:focus-visible { outline: 3px solid #0d8f72; outline-offset: 2px; }
.demo-component { min-height: 102px; padding-block: 4px; }
.demo-note { border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); font-size: 12px; margin: 24px 0 0; padding-top: 18px; }
@media (prefers-reduced-motion: reduce) { .demo-page { transition-duration: .01ms; } }
`;
