import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

// Sourced from ../../docs rather than the usual src/content/docs. The markdown stays browsable on
// GitHub and there is exactly one copy of every page.
export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: "**/*.md", base: "../docs" }),
    schema: docsSchema(),
  }),
};
