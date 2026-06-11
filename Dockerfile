FROM node:22-alpine

WORKDIR /app

# Install dependencies separately so this layer caches between code changes
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy app source (reference/ and node_modules excluded via .dockerignore)
COPY . .

# hearth.yaml is volume-mounted from the host so edits live-reload without
# rebuilding the image. The copy baked in here is a fallback only.

EXPOSE 8787

CMD ["node", "server.mjs"]
