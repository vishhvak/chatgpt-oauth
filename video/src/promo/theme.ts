import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// White, near-black ink, block caret, typing sounds. Apercu carries the type.
export const WHITE = "#FFFFFF";
export const INK = "#0D0D0D";
export const GREEN = "#4CDD7A"; // kept for the long-form promo composition
export const DIM = "#9A9A9A";

export const SANS = "Apercu";
export const MONO = "Apercu Mono";

loadFont({ family: SANS, url: staticFile("fonts/Apercu-400.otf"), weight: "400" });
loadFont({ family: SANS, url: staticFile("fonts/Apercu-500.otf"), weight: "500" });
loadFont({ family: SANS, url: staticFile("fonts/Apercu-700.otf"), weight: "700" });
loadFont({ family: MONO, url: staticFile("fonts/ApercuMono-400.otf"), weight: "400" });
