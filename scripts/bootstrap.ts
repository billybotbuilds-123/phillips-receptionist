#!/usr/bin/env tsx
/**
 * Bootstrap script — run once to set up the database and generate secrets.
 * Usage: npm run bootstrap
 */
import * as readline from 'readline/promises';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { execSync } from 'child_process';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function prompt(question: string, hidden = false): Promise<string> {
  if (hidden) {
    process.stdout.write(question);
    return new Promise((resolve) => {
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      let value = '';
      stdin.on('data', function handler(char: string) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', handler);
          process.stdout.write('\n');
          resolve(value);
        } else if (char === '\u0003') {
          process.exit();
        } else if (char === '\u007f') {
          value = value.slice(0, -1);
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(question + '*'.repeat(value.length));
        } else {
          value += char;
          process.stdout.write('*');
        }
      });
    });
  }
  return rl.question(question);
}

async function main() {
  console.log('\n🚀 Phillips Receptionist — Bootstrap Setup\n');
  console.log('This script will:');
  console.log('  1. Generate your SETTINGS_MASTER_KEY and SESSION_SECRET');
  console.log('  2. Hash your admin password');
  console.log('  3. Run database migrations');
  console.log('  4. Create your admin user\n');

  // 1. Get admin credentials
  const username = await prompt('Admin username (e.g. shane): ');
  if (!username || username.length < 3) {
    console.error('❌ Username must be at least 3 characters');
    process.exit(1);
  }

  const password = await prompt('Admin password (min 12 chars): ', true);
  if (!password || password.length < 12) {
    console.error('❌ Password must be at least 12 characters');
    process.exit(1);
  }

  const confirm = await prompt('Confirm password: ', true);
  if (password !== confirm) {
    console.error('❌ Passwords do not match');
    process.exit(1);
  }

  rl.close();

  // 2. Generate secrets
  console.log('\n⚙️  Generating secrets...');
  const masterKey = crypto.randomBytes(32).toString('hex');
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const passwordHash = await bcrypt.hash(password, 12);

  // 3. Run migrations
  console.log('📦 Running database migrations...');
  try {
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  } catch (err) {
    console.error('❌ Migration failed. Make sure DATABASE_URL is set in your .env file.');
    process.exit(1);
  }

  // 4. Create admin user
  console.log('👤 Creating admin user...');
  try {
    // Dynamic import after migrations run
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    await prisma.user.upsert({
      where: { username },
      create: { username, passwordHash },
      update: { passwordHash },
    });
    await prisma.$disconnect();
    console.log(`✅ Admin user "${username}" created`);
  } catch (err) {
    console.error('❌ Failed to create user:', err);
    process.exit(1);
  }

  // 5. Print env vars
  console.log('\n' + '='.repeat(60));
  console.log('✅ Bootstrap complete!\n');
  console.log('📋 Copy these into Railway → your project → Variables:\n');
  console.log(`SETTINGS_MASTER_KEY=${masterKey}`);
  console.log(`SESSION_SECRET=${sessionSecret}`);
  console.log(`ADMIN_USERNAME=${username}`);
  console.log(`ADMIN_PASSWORD_HASH=${passwordHash}`);
  console.log('\n(DATABASE_URL, PORT, NODE_ENV, PUBLIC_URL, SENTRY_DSN — set those separately)');
  console.log('='.repeat(60));
  console.log('\n📌 Next steps:');
  console.log('  1. Copy the env vars above into Railway');
  console.log('  2. Deploy the web service to Railway');
  console.log('  3. Visit https://<your-railway-url>/login');
  console.log('  4. Log in and go to Settings → fill in your API keys\n');
}

main().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
