/** Defines typed, redacted failures for the experimental Codex app-server transport. */
import { TransportError } from "../core/types.js";

export class AppServerError extends TransportError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerError";
  }
}

export class AppServerRpcError extends AppServerError {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly method: string,
  ) {
    super(`Codex app-server ${method} failed (${rpcCode}): ${message}`);
    this.name = "AppServerRpcError";
  }
}
