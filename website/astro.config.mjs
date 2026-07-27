// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { rehypeDocsLinks } from "./rehype-docs-links.mjs";

const repo = "https://github.com/vishhvak/chatgpt-oauth";
// Served at the root of its own subdomain, so no base path.
const base = "";

export default defineConfig({
  site: "https://chatgpt-oauth.vishhvak.com",
  base,
  markdown: { rehypePlugins: [rehypeDocsLinks({ base })] },
  integrations: [
    starlight({
      title: "chatgpt-oauth",
      description:
        "OAuth and subscription transport for apps whose users bring their own ChatGPT account.",
      social: [{ icon: "github", label: "GitHub", href: repo }],
      customCss: ["./src/styles/quiet.css"],
      // Starlight ships the theme control as an icon <select>. The register wants a bare dot.
      components: {
        ThemeSelect: "./src/components/ThemeToggle.astro",
        Head: "./src/components/Head.astro",
      },
      // Runs before any stylesheet is fetched, so the first paint already has the right theme.
      // Without it the static markup says data-theme="dark" and light users see a dark flash.
      head: [
        {
          tag: "script",
          content: [
            "(function(){",
            // Resolve once, then persist an explicit value. A legacy 'auto' from Starlight's old
            // <select> resolves to the system preference here but to dark in Starlight's own
            // script, so leaving it stored makes the theme depend on which script ran last.
            "function r(){var t=null;try{t=localStorage.getItem('starlight-theme')}catch(e){}",
            "if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';",
            "try{localStorage.setItem('starlight-theme',t)}catch(e){}}return t}",
            "function a(d){d.documentElement.dataset.theme=r();d.documentElement.style.colorScheme=r()}",
            "a(document);",
            // Before the swap so the incoming document is already correct, and after it so nothing
            // that runs during the swap gets the last word.
            "document.addEventListener('astro:before-swap',function(e){a(e.newDocument)});",
            "document.addEventListener('astro:after-swap',function(){a(document)});",
            // Starlight's own theme script sits later in <head> and re-runs on every
            // navigation, and it maps anything that is not exactly 'light' to dark. This
            // fires after all page scripts, so it is the only hook guaranteed to run last.
            "document.addEventListener('astro:page-load',function(){a(document)});",
            "})()",
          ].join(""),
        },
      ],
      editLink: { baseUrl: `${repo}/edit/main/docs/` },
      lastUpdated: true,
      // Pages are authored as plain markdown in ../docs so they stay readable on GitHub; the site
      // renders that same directory rather than keeping a second copy in sync.
      sidebar: [
        { label: "Overview", link: "/" },
        {
          label: "Using it",
          items: [
            { label: "Concepts", link: "/concepts/" },
            { label: "Errors", link: "/errors/" },
            { label: "Storage", link: "/storage/" },
            { label: "Security", link: "/security/" },
          ],
        },
        {
          label: "Operating it",
          items: [
            { label: "Deploying", link: "/deploying/" },
            { label: "Contributing", link: "/contributing/" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Wire protocol", link: `${repo}/blob/main/PROTOCOL.md`, attrs: { target: "_blank" } },
            { label: "TypeScript", link: `${repo}/tree/main/typescript`, attrs: { target: "_blank" } },
            { label: "Python", link: `${repo}/tree/main/python`, attrs: { target: "_blank" } },
            { label: "Swift", link: `${repo}/tree/main/swift`, attrs: { target: "_blank" } },
            { label: "Kotlin", link: `${repo}/tree/main/kotlin`, attrs: { target: "_blank" } },
          ],
        },
      ],
    }),
  ],
});
