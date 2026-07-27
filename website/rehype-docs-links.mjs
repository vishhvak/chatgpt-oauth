import { visit } from "unist-util-visit";

/**
 * Rewrites the relative `./page.md` links used in ../docs into site routes.
 *
 * The pages are authored to be read on GitHub first, where `./errors.md` is the only form that
 * works. Astro's own relative-link resolution does not apply here because the collection is loaded
 * from outside `src/`, so without this the links ship to the site verbatim and 404.
 *
 * @param {{ base: string }} options site base path, e.g. "/chatgpt-oauth"
 */
export function rehypeDocsLinks({ base }) {
  const prefix = base.replace(/\/$/, "");
  return () => (tree) => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string") return;
      const match = /^\.\/([\w-]+)\.md(#.+)?$/.exec(href);
      if (match === null) return;
      const [, name, hash = ""] = match;
      node.properties.href = name === "index" ? `${prefix}/${hash}` : `${prefix}/${name}/${hash}`;
    });
  };
}
