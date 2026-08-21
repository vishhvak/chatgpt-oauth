/**
 * Generates an image, then edits the result, to check the images surface against a live account.
 *
 *     cd typescript && pnpm dlx tsx examples/images.ts "a lighthouse at dusk"
 *
 * Shares the credential store `verify.ts` writes, so run that first if you have not signed in.
 * Requires a paid ChatGPT plan: image generation is unavailable on Free.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { argv, stdout } from "node:process";
import { createAuthSession } from "chatgpt-oauth";
import { createFileStore } from "chatgpt-oauth/node";
import { editImage, generateImage, imageReference } from "chatgpt-oauth/images";

const subject = process.env.CHATGPT_OAUTH_SUBJECT ?? "example-user";
const prompt = argv[2] ?? "A lighthouse at dusk, flat vector illustration, cream background";

const store = await createFileStore({ directory: join(homedir(), ".chatgpt-oauth-example") });
const auth = createAuthSession({ store });

if ((await auth.status(subject)) === null) {
  const device = await auth.startDeviceLogin(subject);
  console.log(`Open ${device.verificationUrl} and enter code ${device.userCode}\n`);
  await device.wait();
}

// Generations run for tens of seconds, so say what is happening rather than sitting silent.
stdout.write(`generating: ${prompt}\n`);
const generated = await generateImage(auth, subject, prompt, { quality: "low" });
const first = generated.images[0];
if (first === undefined) throw new Error("the backend returned no images");

await writeFile("generated.png", first.bytes);
// `size` and `quality` are what the backend chose, which is not always what was asked for.
stdout.write(`  generated.png  ${first.bytes.length} bytes  ${generated.size} ${generated.quality}\n`);

stdout.write("editing the result\n");
const edited = await editImage(
  auth,
  subject,
  [imageReference(first.bytes)],
  "Add a full moon in the sky. Keep everything else identical.",
  { quality: "low" },
);
const revised = edited.images[0];
if (revised === undefined) throw new Error("the backend returned no images");

await writeFile("edited.png", revised.bytes);
stdout.write(`  edited.png     ${revised.bytes.length} bytes\n`);
stdout.write(`quota used this window: ${generated.rateLimits.primary?.usedPercent ?? "?"}%\n`);
