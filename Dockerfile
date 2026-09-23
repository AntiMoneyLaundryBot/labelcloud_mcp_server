# Multi-stage build. The runtime stage never receives a Label Cloud API key
# or an upstream URL baked in — both are supplied at deploy time (compose
# `environment:` for the URL; each consumer sends their own key over HTTP).

FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/
COPY docs/blacklist-api-endpoints.json ./docs/blacklist-api-endpoints.json

EXPOSE 3000
USER node

# The HTTP transport only ever answers POST /mcp; a GET on it is the cheapest
# liveness probe available and must come back 405, never 200/404/5xx.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.MCP_PORT||3000,path:'/mcp'},r=>process.exit(r.statusCode===405?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js", "--http"]
