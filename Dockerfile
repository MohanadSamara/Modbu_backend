# Backend image — Node 20. Talks to Postgres via `pg`; DATABASE_URL is supplied
# at runtime (e.g. Railway's env vars, pointing at a Neon database).
#
# The built frontend must already be in deploy/www before `docker build` runs —
# it lives in a sibling repo, so it can't be COPYed from inside this build
# context. Run `npm run build:frontend` first (see scripts/build-frontend.js).
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 5400

CMD ["node", "index.js"]
