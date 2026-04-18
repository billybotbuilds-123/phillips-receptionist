#!/usr/bin/env tsx
/**
 * Get Google OAuth refresh token — run once during Phase 4 setup.
 * Usage: npm run get-google-token
 *
 * Prerequisites:
 *   - GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env
 *   - Google Cloud Console OAuth credentials created
 *   - http://localhost:3001/callback added as authorized redirect URI
 */
import * as http from 'http';
import { google } from 'googleapis';
import * as dotenv from 'dotenv';

dotenv.config();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3001/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // force consent screen to always get refresh token
});

console.log('\n🔑 Google OAuth Setup\n');
console.log('Opening your browser to authorize...');
console.log('\nIf the browser does not open, visit this URL manually:');
console.log(authUrl);
console.log('\nWaiting for authorization...\n');

// Try to open browser
const { exec } = await import('child_process');
exec(`open "${authUrl}"`);

// Start local server to capture the callback
const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) return;

  const url = new URL(req.url, 'http://localhost:3001');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end(`<h1>Error: ${error}</h1><p>Authorization was denied or failed.</p>`);
    console.error('❌ Authorization failed:', error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.end('<h1>No code received</h1>');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.end(`
      <h1>✅ Authorization successful!</h1>
      <p>You can close this tab and return to the terminal.</p>
    `);

    console.log('\n' + '='.repeat(60));
    console.log('✅ Google authorization complete!\n');
    console.log('📋 Add this to your Settings → Google tab in the admin dashboard:\n');
    console.log(`Refresh token: ${tokens.refresh_token}`);
    console.log('\n(Access token expires and is auto-refreshed — do not save it)');
    console.log('='.repeat(60));
    console.log('\n📌 Next steps:');
    console.log('  1. Copy the refresh token above');
    console.log('  2. Go to https://office.educationalsuccessexpert.com/admin/settings');
    console.log('  3. Click "Google" tab → paste refresh token → Save\n');

  } catch (err) {
    res.end(`<h1>Error exchanging code</h1><pre>${err}</pre>`);
    console.error('❌ Token exchange failed:', err);
  }

  server.close();
});

server.listen(3001, () => {
  // listening...
});

server.on('error', (err) => {
  console.error('❌ Could not start local server on port 3001:', err);
  console.error('Make sure port 3001 is free and try again.');
  process.exit(1);
});
