# Playwright's own image ships with Chromium AND every OS-level library it
# needs already installed. Render's plain Node build environment can't run
# `playwright install --with-deps` (it isn't allowed to become root to
# apt-get those libraries - that's exactly the "su: Authentication failure"
# build error this Dockerfile exists to avoid), so this sidesteps the
# problem entirely by starting from an image that already has them.
#
# The version tag MUST match the "playwright" version actually locked in
# server/package-lock.json (currently 1.63.0) - a mismatch between the npm
# package and the image's bundled browser is the most common way this
# setup breaks. After any dependency update, check:
#   grep -A2 '"playwright"' server/package-lock.json
# and bump this tag to match if it changed.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# Install the client's dependencies first (separate COPY so Docker can
# cache this layer and skip reinstalling on every code change, as long as
# package.json/package-lock.json haven't changed).
COPY client/package.json client/package-lock.json client/
RUN npm --prefix client ci

COPY client/ client/
RUN npm --prefix client run build

# Same caching idea for the server. Browsers are already baked into this
# base image, so - unlike the old Render-native build command - there's no
# separate `playwright install` step needed here at all.
COPY server/package.json server/package-lock.json server/
RUN npm --prefix server ci --omit=dev

COPY server/ server/

ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "server/src/index.js"]
