# The render worker. Chromium needs system libraries the native Node runtime lacks, so this runs
# on the Playwright image. The image tag must match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @socia/worker build

ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/index.js", "render"]
