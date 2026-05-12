import { PrismaClient } from '@prisma/client';

const db = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL'] } }
});

const users = await db.user.findMany({ select: { id: true, username: true } });
console.log('Existing users:', JSON.stringify(users));

const hash = '$2b$12$xuCtfBgHeVwRmCkSE3i6d.5wtbo5zo5r./LjyzezsLRNvQjEm9ovG';
await db.user.upsert({
  where: { username: 'shane' },
  create: { username: 'shane', password_hash: hash },
  update: { password_hash: hash }
});
console.log('✅ User upserted');
await db.$disconnect();
