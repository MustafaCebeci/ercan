// test/mocks/time.js
// Mock time utilities for testing temporal-dependent code

import { vi } from 'vitest';

// Store the mocked "current" time
let mockedNow = null;

// Set a specific mocked time
export function setMockedTime(dateTimeString) {
  // Create a Temporal.Now for the specific time
  // We use a plain object to simulate the behavior
  mockedNow = dateTimeString;
}

// Reset to real time
export function resetTime() {
  mockedNow = null;
}

// Get current mocked time or null
export function getMockedTime() {
  return mockedNow;
}

// Mock Temporal.Now for consistent testing
export function createMockNow(overrides = {}) {
  const date = overrides.date || '2026-06-07';
  const hour = overrides.hour ?? 10;
  const minute = overrides.minute ?? 30;
  const second = overrides.second ?? 0;

  return {
    hour,
    minute,
    second,
    year: parseInt(date.split('-')[0]),
    month: parseInt(date.split('-')[1]),
    day: parseInt(date.split('-')[2]),
    dayOfWeek: overrides.dayOfWeek ?? 7, // Default to Sunday
    toPlainDate: () => ({
      toString: () => date,
      year: parseInt(date.split('-')[0]),
      month: parseInt(date.split('-')[1]),
      day: parseInt(date.split('-')[2]),
    }),
    toPlainDateTime: () => ({
      hour,
      minute,
      second,
      year: parseInt(date.split('-')[0]),
      month: parseInt(date.split('-')[1]),
      day: parseInt(date.split('-')[2]),
    }),
    ...overrides,
  };
}

// Common mock times for testing
export const mockTimes = {
  // A typical business hour (10:30 AM on a Tuesday)
  businessHour: createMockNow({ hour: 10, minute: 30, dayOfWeek: 2, date: '2026-06-09' }),

  // Early morning (before open)
  earlyMorning: createMockNow({ hour: 8, minute: 0, dayOfWeek: 2, date: '2026-06-09' }),

  // Late evening (after close)
  lateEvening: createMockNow({ hour: 23, minute: 0, dayOfWeek: 2, date: '2026-06-09' }),

  // Weekend (Saturday)
  weekend: createMockNow({ hour: 14, minute: 0, dayOfWeek: 6, date: '2026-06-13' }),

  // Past time (for slot generation filtering)
  pastTime: createMockNow({ hour: 6, minute: 0, dayOfWeek: 1, date: '2026-06-01' }),
};

// Helper to create a mock ZonedDateTime
export function createMockZonedDateTime(ymd, hour = 0, minute = 0, timezone = 'Europe/Istanbul') {
  return {
    hour,
    minute,
    second: 0,
    year: parseInt(ymd.split('-')[0]),
    month: parseInt(ymd.split('-')[1]),
    day: parseInt(ymd.split('-')[2]),
    dayOfWeek: 1,
    timeZoneId: timezone,
    toPlainDateTime: () => ({
      hour,
      minute,
      second: 0,
      year: parseInt(ymd.split('-')[0]),
      month: parseInt(ymd.split('-')[1]),
      day: parseInt(ymd.split('-')[2]),
    }),
    toPlainDate: () => ({
      year: parseInt(ymd.split('-')[0]),
      month: parseInt(ymd.split('-')[1]),
      day: parseInt(ymd.split('-')[2]),
    }),
    toString: () => `${ymd}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00[${timezone}]`,
  };
}

// Mock Temporal module
export const mockTemporal = {
  PlainDate: {
    from: (ymd) => ({
      year: parseInt(ymd.split('-')[0]),
      month: parseInt(ymd.split('-')[1]),
      day: parseInt(ymd.split('-')[2]),
      dayOfWeek: 1,
    }),
  },
  PlainDateTime: {
    from: (str) => {
      const [datePart, timePart] = str.split('T');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hour, minute, second] = (timePart || '00:00:00').split(':').map(Number);
      return { year, month, day, hour, minute, second };
    },
  },
  ZonedDateTime: {
    from: (str) => createMockZonedDateTime('2026-06-07', 10, 30),
  },
};