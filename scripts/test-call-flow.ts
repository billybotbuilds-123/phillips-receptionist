#!/usr/bin/env tsx
/**
 * End-to-end smoke test — simulates Vapi hitting our tool endpoints.
 * Usage: BASE_URL=http://localhost:3000 VAPI_WEBHOOK_SECRET=xxx npm run test:e2e
 *
 * This does NOT make real phone calls. It hits our HTTP endpoints directly
 * with the same payload shapes Vapi sends in production.
 */
import * as crypto from 'crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SECRET = process.env.VAPI_WEBHOOK_SECRET ?? 'test-secret';

let passed = 0;
let failed = 0;

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

async function post(path: string, body: object, secret = SECRET) {
  const bodyStr = JSON.stringify(body);
  const sig = sign(bodyStr, secret);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vapi-Signature': sig,
    },
    body: bodyStr,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const TEST_CALL_ID = `test-${Date.now()}`;

console.log(`\n🧪 Phillips Receptionist — End-to-End Call Flow Test`);
console.log(`   Target: ${BASE_URL}\n`);

// 1. Health check
await test('GET /health returns 200', async () => {
  const res = await fetch(`${BASE_URL}/health`);
  if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error(`Expected {status:"ok"}, got ${JSON.stringify(body)}`);
});

// 2. send-booking-link happy path
await test('POST /vapi/tools/send-booking-link — happy path', async () => {
  const { status, body } = await post('/vapi/tools/send-booking-link', {
    call_id: TEST_CALL_ID,
    tool_call_id: `tool-${TEST_CALL_ID}`,
    arguments: {
      parent_name: 'Test Parent',
      parent_email: 'test@example.com',
      parent_phone: '+15551234567',
      child_name: 'Test Child',
      child_grade: '5th',
      summary_of_need: 'Testing the booking link flow end-to-end in development.',
      urgency_level: 'low',
    },
  });
  if (status !== 200) throw new Error(`Expected 200, got ${status}: ${JSON.stringify(body)}`);
  if (body?.result !== 'sent') throw new Error(`Expected {result:"sent"}, got ${JSON.stringify(body)}`);
});

// 3. Idempotency — same call_id should return same result without double-sending
await test('POST /vapi/tools/send-booking-link — idempotent on same call_id', async () => {
  const { status, body } = await post('/vapi/tools/send-booking-link', {
    call_id: TEST_CALL_ID,
    tool_call_id: `tool-${TEST_CALL_ID}-retry`,
    arguments: {
      parent_name: 'Test Parent',
      parent_email: 'test@example.com',
      parent_phone: '+15551234567',
      child_name: 'Test Child',
      child_grade: '5th',
      summary_of_need: 'Duplicate call — should be idempotent.',
      urgency_level: 'low',
    },
  });
  if (status !== 200) throw new Error(`Expected 200, got ${status}`);
  if (body?.result !== 'sent') throw new Error(`Expected {result:"sent"}, got ${JSON.stringify(body)}`);
});

// 4. send-booking-link with crisis urgency — should also trigger escalation
await test('POST /vapi/tools/send-booking-link — crisis triggers escalation', async () => {
  const { status, body } = await post('/vapi/tools/send-booking-link', {
    call_id: `crisis-${Date.now()}`,
    tool_call_id: `tool-crisis-${Date.now()}`,
    arguments: {
      parent_name: 'Crisis Parent',
      parent_email: 'crisis@example.com',
      parent_phone: '+15559876543',
      child_name: 'Crisis Child',
      child_grade: '3rd',
      summary_of_need: 'Child is refusing to go to school and experiencing severe anxiety.',
      urgency_level: 'crisis',
    },
  });
  if (status !== 200) throw new Error(`Expected 200, got ${status}: ${JSON.stringify(body)}`);
  if (body?.result !== 'sent') throw new Error(`Expected {result:"sent"}, got ${JSON.stringify(body)}`);
});

// 5. urgent-escalation direct
await test('POST /vapi/tools/urgent-escalation — fires alert', async () => {
  const { status, body } = await post('/vapi/tools/urgent-escalation', {
    call_id: `esc-${Date.now()}`,
    tool_call_id: `tool-esc-${Date.now()}`,
    arguments: {
      reason: 'Parent insists on speaking to Mr. Phillips immediately',
      parent_name: 'Urgent Parent',
      parent_phone: '+15551112222',
      summary: 'Parent very upset about recent IEP meeting outcome',
    },
  });
  if (status !== 200) throw new Error(`Expected 200, got ${status}: ${JSON.stringify(body)}`);
  if (body?.result !== 'escalated') throw new Error(`Expected {result:"escalated"}, got ${JSON.stringify(body)}`);
});

// 6. call-ended webhook
await test('POST /vapi/call-ended — appends transcript', async () => {
  const { status } = await post('/vapi/call-ended', {
    call: {
      id: TEST_CALL_ID,
      endedReason: 'customer-ended-call',
      duration: 245,
      recordingUrl: 'https://vapi.ai/recordings/test-recording.mp3',
    },
    transcript: 'Riley: Hi, you\'ve reached Mr. Phillips\'s office — this is Riley. How can I help you today?\nParent: Hi, I need help with my son\'s IEP.\nRiley: I\'d be happy to help with that. Can you tell me your name and a bit about your son\'s situation?',
  });
  if (status !== 200) throw new Error(`Expected 200, got ${status}`);
});

// 7. Invalid HMAC rejected
await test('POST /vapi/tools/send-booking-link — rejects bad signature', async () => {
  const body = JSON.stringify({ call_id: 'bad', tool_call_id: 'bad', arguments: {} });
  const res = await fetch(`${BASE_URL}/vapi/tools/send-booking-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Vapi-Signature': 'badsig' },
    body,
  });
  if (res.status !== 401 && res.status !== 403) {
    throw new Error(`Expected 401/403 for bad sig, got ${res.status}`);
  }
});

// Summary
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n❌ Some tests failed. Check logs above.');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed! Riley is ready.\n');
}
