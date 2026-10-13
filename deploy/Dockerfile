# Playwright base pins Chromium + OS libraries to the exact version in
# package-lock.json — that is what keeps capture/diff metrics identical to
# local runs. Do not switch to a plain node image without re-validating.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# pi CLI powers agent-driven generation (OPTIONAL: only used with --allow-agent)
ARG PI_CODING_AGENT_VERSION=1.2.0
RUN npm i -g "@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}"

# libarchive-tools = bsdtar, required for repro zip extraction
RUN apt-get update \
 && apt-get install -y --no-install-recommends libarchive-tools git unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages ./packages
# the copypage skill is loaded by the generation agent (--skill /app/skill)
COPY skill ./skill

# browsers are preinstalled in the base image; never download again
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund

ENV NODE_ENV=production \
    COPYPAGE_DATA_DIR=/data
# run as the image's non-root user (uid 1000) so host mounts stay correctly owned
RUN mkdir -p /data && chown 1000:1000 /data
VOLUME ["/data"]
EXPOSE 4400

# policy comes from env (see .env.example); the app port is only exposed to
# the compose network — publish it through the reverse proxy instead
CMD ["node_modules/.bin/tsx", "packages/server/src/cli.ts", "--host", "0.0.0.0", "--port", "4400", "--data-dir", "/data"]
