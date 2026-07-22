/** Mounts the login lifecycle as a Next.js App Router catch-all route. */
import { createChatGPTHandler, type ChatGPTHandlerOptions } from "../http/index.js";
import type { AuthSession } from "../core/types.js";

export type { ChatGPTHandlerOptions, PendingLoginStore } from "../http/index.js";

/**
 * Returns the `GET` and `POST` exports for `app/<basePath>/[...chatgpt]/route.ts`.
 *
 * ```ts
 * export const { GET, POST } = toNextJsHandler(auth, {
 *   secret: process.env.CHATGPT_OAUTH_SECRET!,
 *   subject: async (request) => (await requireAppSession(request)).user.id,
 * });
 * ```
 */
export function toNextJsHandler(
  auth: AuthSession,
  options: ChatGPTHandlerOptions,
): { GET: (request: Request) => Promise<Response>; POST: (request: Request) => Promise<Response> } {
  const handle = createChatGPTHandler(auth, options);
  return { GET: handle, POST: handle };
}
