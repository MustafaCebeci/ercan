// test/setup.js
// Global test setup - runs before all tests

// Mock environment variables for tests
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-testing-only';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.BUSINESS_TIMEZONE = 'Europe/Istanbul';
process.env.PERSONAL_BUSINESS_ID = '1';
process.env.PERSONAL_BRANCH_ID = '1';
process.env.SMS_USER = 'test';
process.env.SMS_PASS = 'test';
process.env.SMS_BASLIK = 'TEST';
process.env.SMS_ENDPOINT = 'https://test.api.mesajpaneli.com';
process.env.SMS_VERIFY_SSL = 'false';

// Increase timeout for CI environments
if (process.env.CI) {
  jest?.setTimeout?.(30000);
}

// Global teardown (runs after all tests)
export async function globalTeardown() {
  // Cleanup any test resources
}

// Global test utilities
export const testHelpers = {
  // Create a minimal valid appointment payload
  validAppointmentPayload: (overrides = {}) => ({
    phone: '5467473915',
    name: 'Test User',
    staff_id: 1,
    service_id: 1,
    date: '2026-06-15',
    time: '10:00',
    ...overrides,
  }),

  // Create a minimal valid closure payload
  validClosurePayload: (overrides = {}) => ({
    scope: 'global',
    start_at: '2026-06-15 09:00:00',
    end_at: '2026-06-15 18:00:00',
    is_all_day: 0,
    ...overrides,
  }),

  // Create a minimal valid period settings payload
  validPeriodSettingsPayload: (overrides = {}) => ({
    name: 'Yaz Dönemi',
    start_date: '2026-06-15',
    end_date: '2026-09-15',
    data_json: {
      settings: {
        start_hour: '10:00',
        end_hour: '20:00',
        closed_days: [],
      },
    },
    ...overrides,
  }),
};