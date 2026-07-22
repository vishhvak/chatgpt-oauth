# Deploying the render-service template

[`typescript/examples/render-service`](../typescript/examples/render-service/README.md) is the deployable reference for a hosted app that combines OAuth, a subject-keyed PostgreSQL store, and the Codex app-server transport. Copy it into your application and own its authentication, storage, operations, and policy posture. It is not part of the published `chatgpt-oauth` package.

The container embeds the Codex binary; there is no remote app-server URL. At runtime, the service lazily starts one child process for one authenticated application subject and binds that process to that subject for its entire life. A process may handle later turns for the same subject, but it must never handle a second subject.

Concrete example: if Alice already owns process A, Bob's `/chat` request must create process B. Routing Bob through process A would mix account custody and turn the service into the exact shared token/process pool this template is designed to prevent.

Do not turn this example into a shared pool, subscription broker, or resale service. Use it only for personal or self-hosted software unless OpenAI approves your exact use, and keep an API-key or local-model fallback. See the example README for environment variables, local startup, and Render and Railway deployment steps.
