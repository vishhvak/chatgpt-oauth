/** Node entry point for encrypted file custody and secure loopback callbacks. */
export { createFileCredentialStore, fileModes } from "./file-store.js";
export type { FileStoreOptions } from "./file-store.js";
export { waitForLoopbackCallback } from "./loopback.js";
export type { LoopbackOptions } from "./loopback.js";
