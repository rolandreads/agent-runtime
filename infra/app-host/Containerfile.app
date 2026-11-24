# App image: build from :deps, run from :runtime.
FROM localhost/agent-runtime:deps AS build

COPY . .
RUN bun run build

FROM localhost/agent-runtime:runtime

COPY --from=build /app/dist /app/dist
COPY --from=build /app/infra/app-host/litestream.yml /app/litestream.yml
COPY --from=build /app/src/db /app/src/db

USER agent-runtime:agent-runtime

CMD ["litestream", "replicate", "-log-level", "warn", "-config", "/app/litestream.yml", "-exec", "bun /app/dist/index.js"]
