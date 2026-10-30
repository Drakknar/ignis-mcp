# Upstream Ignis image plus the MCP server plugin. The workflow passes the exact
# upstream digest it checked, so each build is reproducible.
ARG BASE_IMAGE=nobbe/ignis:latest

# Install the plugin's dependencies outside the Ignis npm workspace, so npm
# doesn't try to treat the plugin as part of it.
FROM node:22-slim AS deps
WORKDIR /plugin
COPY plugin/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# The build workflow passes the exact upstream digest as BASE_IMAGE.
# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

ARG PLUGIN_DIR=/app/apps/ignis-server/server/plugins/mcp

# Fail the build if upstream moved its plugin folder, instead of shipping a
# plugin that never gets discovered.
RUN test -d /app/apps/ignis-server/server/plugins/headless-sync

COPY plugin/ ${PLUGIN_DIR}/
COPY --from=deps /plugin/node_modules/ ${PLUGIN_DIR}/node_modules/

RUN node -e "const p = require('${PLUGIN_DIR}'); if (p.id !== 'mcp' || typeof p.register !== 'function') process.exit(1)"
