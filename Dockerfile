FROM node:20-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Type check only — MJML already compiled and committed
RUN npx tsc --noEmit

# Generate Prisma client
RUN npx prisma generate

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push --skip-generate && npx tsx src/index.ts"]
