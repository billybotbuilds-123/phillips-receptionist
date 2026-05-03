FROM node:20-slim

# Cache bust: 2026-05-03-005731
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Install all deps including devDeps for tsx
RUN npm ci --include=dev

COPY . .

# Generate Prisma client first (required for type checking)
RUN npx prisma generate

# Type check
RUN npx tsc --noEmit

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push --skip-generate && ./node_modules/.bin/tsx src/index.ts"]
