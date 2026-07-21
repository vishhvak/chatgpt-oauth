import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createAuthSession } from "chatgpt-oauth";
import { createAppServerClient } from "chatgpt-oauth/app-server";
import { createFileCredentialStore, waitForLoopbackCallback } from "chatgpt-oauth/node";

const subject = "default";
const store = await createFileCredentialStore({
  directory: join(homedir(), ".chatgpt-oauth-example"),
});
const auth = createAuthSession({ store });
const terminal = createInterface({ input: stdin, output: stdout });
let ai: Awaited<ReturnType<typeof createAppServerClient>> | undefined;

try {
  if (await auth.status(subject) === null) {
    const pending = await auth.beginLogin();
    console.log(`Open this URL in your browser:\n${pending.url}\n`);
    const callback = await waitForLoopbackCallback(pending);
    await auth.completeLogin(subject, callback, pending);
  }

  const prompt = await terminal.question("Prompt: ");
  ai = await createAppServerClient(auth, subject);
  for await (const event of ai.stream({ model: "gpt-5.4-mini", input: prompt })) {
    if (event.type === "response.output_text.delta") stdout.write(event.delta ?? "");
  }
  stdout.write("\n");
} finally {
  await ai?.close();
  terminal.close();
}
