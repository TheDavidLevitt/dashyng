# Dashboard — Cloud Run image
# Auth comes from the attached service account (ADC) — no key file is copied in.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# Copy the WHOLE build context — it is already filtered by .gcloudignore (runtime caches,
# secrets, and local config never reach the upload). An explicit file list here silently
# dropped a newly added module (config.js) on 2026-07-05 and took two revisions down.
COPY . .
# Cloud Run injects PORT; server.js already honors it
EXPOSE 8080
CMD ["node", "server.js"]
