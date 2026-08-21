/** @type {import('next').NextConfig} */
export default {
  // The library is workspace-linked and ships ESM; Next must not try to bundle it for the server.
  serverExternalPackages: ["chatgpt-oauth"],
};
