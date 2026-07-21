FROM node:20-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
    && npm install --global @openai/codex

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build \
    && pnpm build:render-service

# The Codex binary runs inside this container. There is intentionally no
# external app-server URL: each child process belongs to one subject for life.
ENV NODE_ENV=production
CMD ["node", "examples/render-service/dist/index.js"]
