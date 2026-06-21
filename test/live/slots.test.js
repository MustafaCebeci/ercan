// backend/test/live/slots.test.js
/**
 * Canlı DB Testleri - Slot Generation
 * Backend çalışırken gerçek HTTP istekleri ile test
 */

const API = 'http://localhost:3000/api';
const jwt = require('jsonwebtoken');

// Test token oluştur (customer ID: 8)
const secret = process.env.JWT_SECRET || 'test-secret';
const customerToken = jwt.sign({ sub: 8, type: 'customer' }, secret, { expiresIn: '1d' });

console.log(`Test Token: ${customerToken ? '✅ Generated' : '❌ Failed'}`);

async function apiGet(path, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { headers });
  return res.json();
}

async function apiPost(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return res.json();
}

let testsRun = 0, testsPassed = 0, testsFailed = 0;

function logResult(name, passed, error = null) {
  testsRun++;
  if (passed) {
    testsPassed++;
    console.log(`  ✅ ${name}`);
  } else {
    testsFailed++;
    console.log(`  ❌ ${name}${error ? ': ' + error : ''}`);
  }
}

async function runTests() {
  console.log('\n=== Slot Generation Tests ===\n');

  // Test 1: Unauthenticated request should fail
  console.log('1. Authentication Tests:');
  const unauthSlots = await apiGet('/appointments/slots/generate', null);
  logResult('Unauthenticated request should fail', !unauthSlots.ok, unauthSlots.message);

  // Test 2: Get slots with valid auth
  console.log('\n2. Slot Generation Tests:');
  const slots = await apiPost('/appointments/slots/generate', {
    date: '2026-06-10',
    staffId: 1,
    serviceId: 1
  }, customerToken);
  logResult('Get slots for 2026-06-10', Array.isArray(slots), !Array.isArray(slots) ? slots.message : null);

  // Test 3: Get slots for different date
  const slotsTomorrow = await apiPost('/appointments/slots/generate', {
    date: '2026-06-11',
    staffId: 1,
    serviceId: 1
  }, customerToken);
  logResult('Get slots for 2026-06-11', Array.isArray(slotsTomorrow));

  // Test 4: Invalid date format
  const invalidDate = await apiPost('/appointments/slots/generate', {
    date: 'invalid-date',
    staffId: 1
  }, customerToken);
  logResult('Invalid date format should return error', !invalidDate.ok, invalidDate.message);

  // Test 5: Missing staffId
  const noStaff = await apiPost('/appointments/slots/generate', {
    date: '2026-06-10'
  }, customerToken);
  logResult('Missing staffId should return error', !noStaff.ok);

  // Test 6: Check slot structure
  console.log('\n3. Slot Structure Tests:');
  if (slots && slots.length > 0) {
    const firstSlot = slots[0];
    logResult('Slot has time property', typeof firstSlot.time === 'string', typeof firstSlot.time !== 'string' ? JSON.stringify(firstSlot) : null);
    logResult('Slot has status property', typeof firstSlot.status === 'string');
    logResult('Slot has available property', firstSlot.available !== undefined);
    logResult('Slot has providerId property', firstSlot.providerId !== undefined);
    console.log(`   First slot: ${JSON.stringify(firstSlot).slice(0, 80)}...`);
  } else {
    logResult('Slot structure check', false, 'No slots returned - may be closed day or no staff');
  }

  // Test 7: Test with different staff
  const slotsStaff2 = await apiPost('/appointments/slots/generate', {
    date: '2026-06-12',
    staffId: 2,
    serviceId: 1
  }, customerToken);
  logResult('Get slots for different staff', Array.isArray(slotsStaff2));

  // Test 8: Service filter
  const slotsWithService = await apiPost('/appointments/slots/generate', {
    date: '2026-06-13',
    staffId: 1,
    serviceId: 1
  }, customerToken);
  logResult('Get slots with service filter', Array.isArray(slotsWithService));

  console.log(`\n--- Results: ${testsPassed}/${testsRun} passed ---\n`);

  return { passed: testsPassed, failed: testsFailed, total: testsRun };
}

runTests().catch(console.error);