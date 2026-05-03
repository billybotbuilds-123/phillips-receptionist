FROM node:20-slim

# Cache bust: 2026-05-03-v2
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Generate Prisma client first (required for type checking)
RUN npx prisma generate

# Type check only — MJML already compiled and committed
RUN npx tsc --noEmit

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push --skip-generate && npx tsx src/index.ts"]
