/**
 * Signs in and streams one response, to check the port against a live account.
 *
 *     cd typescript && pnpm dlx tsx examples/verify.ts
 *
 * Credentials land in an encrypted file store, so a second run skips the sign-in and exercises
 * refresh instead. Delete ~/.chatgpt-oauth-example to start over. `node-cli/index.ts` shows the
 * same flow with a browser redirect instead of a device code.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { stdout } from "node:process";
import { createAuthSession, createClient } from "chatgpt-oauth";
import { createFileStore } from "chatgpt-oauth/node";

const subject = "example-user";
const model = "gpt-5.4-mini";

const store = await createFileStore({ directory: join(homedir(), ".chatgpt-oauth-example") });
const auth = createAuthSession({ store });

if ((await auth.status(subject)) === null) {
  const device = await auth.startDeviceLogin(subject);
  console.log(`Open ${device.verificationUrl} and enter code ${device.userCode}\n`);
  await device.wait();
}

const ai = createClient(auth, subject);
for await (const event of ai.stream({ model, input: "Say hello in five words." })) {
  if (event.delta !== undefined) stdout.write(event.delta);
}
stdout.write("\n");
