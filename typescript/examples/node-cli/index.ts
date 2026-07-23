import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createAuthSession, createClient } from "chatgpt-oauth";
import { createFileStore, waitForLoopbackCallback } from "chatgpt-oauth/node";

const subject = "default";
const store = await createFileStore({
  directory: join(homedir(), ".chatgpt-oauth-example"),
});
const auth = createAuthSession({ store });
const terminal = createInterface({ input: stdin, output: stdout });

try {
  if ((await auth.status(subject))?.status !== "connected") {
    const pending = await auth.beginLogin();
    console.log(`Open this URL in your browser:\n${pending.url}\n`);
    const callback = await waitForLoopbackCallback(pending);
    await auth.completeLogin(subject, callback, pending);
  }

  const prompt = await terminal.question("Prompt: ");
  const ai = createClient(auth, subject);
  for await (const event of ai.stream({ model: "gpt-5.4-mini", input: prompt })) {
    if (event.type === "response.output_text.delta") stdout.write(event.delta ?? "");
  }
  stdout.write("\n");
} finally {
  terminal.close();
}
