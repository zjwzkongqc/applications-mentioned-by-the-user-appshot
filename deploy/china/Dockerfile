FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY src/ ./src/
COPY scripts/build-node.mjs ./scripts/build-node.mjs
RUN node scripts/build-node.mjs

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/node/ ./dist/node/
COPY --chown=node:node server/ ./server/
COPY --chown=node:node drizzle/ ./drizzle/
COPY --chown=node:node scripts/backup-format.mjs scripts/import-backup.mjs ./scripts/
RUN mkdir -p /var/lib/tennis && chown node:node /var/lib/tennis && chmod 700 /var/lib/tennis
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/var/lib/tennis/data TRUST_PROXY_HOPS=1
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/main.mjs"]
