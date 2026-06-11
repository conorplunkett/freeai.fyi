FROM node:20-alpine

WORKDIR /app

# install only production deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV PORT=8787
EXPOSE 8787

# run migrations then boot (idempotent — safe on every deploy)
CMD ["sh", "-c", "node src/migrate.js && node src/index.js"]
