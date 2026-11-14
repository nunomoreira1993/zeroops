# Imagem unica para API, worker e comandos administrativos (migrate/bootstrap).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/executor/package.json apps/executor/
COPY apps/connectors/package.json apps/connectors/
COPY packages/backend/package.json packages/backend/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/sql ./sql
# Fila em disco dos alertas (volume nomeado herda o dono node na primeira montagem).
RUN mkdir -p /var/lib/zeroops/alert-spool /var/lib/zeroops/prometheus-rules \
  && chown node:node /var/lib/zeroops/alert-spool /var/lib/zeroops/prometheus-rules
USER node
CMD ["node", "dist/apps/api/src/main.js"]

# Executor: Copilot CLI + comandos de leitura (zo-sql/zo-loki/zo-prom) que falam com o servico de conectores.
# Arranca como root apenas para lancar o Copilot com o uid do agente (ZEROOPS_AGENT_UID).
# O SDK (@github/copilot-sdk) lanca o runtime atraves de zo-copilot-agent, que baixa para esse uid.
FROM runtime AS executor
USER root
# Versao emparelhada com @github/copilot-sdk 1.0.30 (protocolo 3).
ARG COPILOT_CLI_VERSION=1.0.108
# O pacote do Copilot e extraido no build: o tmpfs e noexec e nao deve gastar RAM com ~260 MB.
ENV COPILOT_CACHE_HOME=/opt/copilot-cache
ENV ZEROOPS_COPILOT_CLI_PATH=/usr/local/bin/zo-copilot-agent
# O runtime nativo do Copilot valida TLS pela trust store do sistema (a imagem slim nao a traz).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --no-audit --no-fund "@github/copilot@${COPILOT_CLI_VERSION}" \
  && npm cache clean --force \
  && HOME=/tmp copilot --version \
  && chmod -R a+rX /opt/copilot-cache \
  && rm -rf /app/node_modules/@github/copilot-sdk-* \
  && printf '#!/bin/sh\nexec node /app/dist/apps/executor/src/connector-cli.js sql "$@"\n' > /usr/local/bin/zo-sql \
  && printf '#!/bin/sh\nexec node /app/dist/apps/executor/src/connector-cli.js loki "$@"\n' > /usr/local/bin/zo-loki \
  && printf '#!/bin/sh\nif [ -n "$ZEROOPS_AGENT_UID" ]; then\n  exec setpriv --reuid="$ZEROOPS_AGENT_UID" --regid="${ZEROOPS_AGENT_GID:-$ZEROOPS_AGENT_UID}" --clear-groups -- copilot "$@"\nfi\nexec copilot "$@"\n' > /usr/local/bin/zo-copilot-agent \
  && chmod 755 /usr/local/bin/zo-sql /usr/local/bin/zo-loki /usr/local/bin/zo-copilot-agent \
  && setpriv --version
RUN printf '#!/bin/sh\nexec node /app/dist/apps/executor/src/connector-cli.js prom "$@"\n' > /usr/local/bin/zo-prom \
  && printf '#!/bin/sh\nexec node /app/dist/apps/executor/src/connector-cli.js log "$@"\n' > /usr/local/bin/zo-log \
  && printf '#!/bin/sh\nexec node /app/dist/apps/executor/src/connector-cli.js db2 "$@"\n' > /usr/local/bin/zo-db2 \
  && chmod 755 /usr/local/bin/zo-prom /usr/local/bin/zo-log /usr/local/bin/zo-db2
CMD ["node", "dist/apps/executor/src/main.js"]

# Alvo por omissao (api, worker, connectors, migrate).
FROM runtime
