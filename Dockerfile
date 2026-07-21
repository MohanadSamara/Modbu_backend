# Backend image — Node 20, oracledb runs in thin mode (no Oracle client needed).
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 5400

CMD ["node", "index.js"]
