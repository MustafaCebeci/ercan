// test/unit/temporal_api.utils.test.js
/**
 * temporal_api.utils.js Unit Tests
 * ~32 fonksiyon için kapsamlı test coverage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the BUSINESS_TZ env before importing
const ORIGINAL_TZ = process.env.BUSINESS_TIMEZONE;
process.env.BUSINESS_TIMEZONE = 'Europe/Istanbul';

const t = require('../../temporal_api.utils.js');

afterEach(() => {
  vi.restoreAllMocks();
});

// ===============================
// CONFIG
// ===============================
describe('getBusinessTimezone()', () => {
  it('returns Europe/Istanbul (configured in test/setup.js)', () => {
    expect(t.getBusinessTimezone()).toBe('Europe/Istanbul');
  });
});

// ===============================
// CONVERSIONS - DB Format <-> Temporal
// ===============================
describe('fromDBDateTime()', () => {
  it('parses "2026-06-05 13:30:00" → PlainDateTime with correct values', () => {
    const result = t.fromDBDateTime('2026-06-05 13:30:00');
    expect(result).not.toBeNull();
    expect(result.year).toBe(2026);
    expect(result.month).toBe(6);
    expect(result.day).toBe(5);
    expect(result.hour).toBe(13);
    expect(result.minute).toBe(30);
    expect(result.second).toBe(0);
  });

  it('parses "2026-06-05T13:30:00+03:00[Europe/Istanbul]" ZonedDateTime format', () => {
    const result = t.fromDBDateTime('2026-06-05T13:30:00+03:00[Europe/Istanbul]');
    expect(result).not.toBeNull();
    expect(result.year).toBe(2026);
    expect(result.hour).toBe(13);
  });

  it('handles null input → returns null', () => {
    expect(t.fromDBDateTime(null)).toBeNull();
  });

  it('handles undefined input → returns null', () => {
    expect(t.fromDBDateTime(undefined)).toBeNull();
  });

  it('handles empty string → returns null', () => {
    expect(t.fromDBDateTime('')).toBeNull();
  });

  it('handles whitespace-only string → returns null', () => {
    expect(t.fromDBDateTime('   ')).toBeNull();
  });

  it('handles "Z" suffix (UTC) → parses correctly', () => {
    const result = t.fromDBDateTime('2026-06-05T13:30:00Z');
    expect(result).not.toBeNull();
    expect(result.hour).toBe(13); // or adjusted for timezone offset
  });

  it('trims whitespace from input', () => {
    const result = t.fromDBDateTime('  2026-06-05 13:30:00  ');
    expect(result.year).toBe(2026);
  });
});

describe('toDBDateTime()', () => {
  it('converts PlainDateTime → "YYYY-MM-DD HH:MM:SS" format', () => {
    const pdt = Temporal.PlainDateTime.from('2026-06-05T13:30:00');
    const result = t.toDBDateTime(pdt);
    expect(result).toBe('2026-06-05 13:30:00');
  });

  it('pads single-digit month with zero', () => {
    const pdt = Temporal.PlainDateTime.from('2026-01-05T09:00:00');
    const result = t.toDBDateTime(pdt);
    expect(result).toBe('2026-01-05 09:00:00');
  });

  it('pads single-digit hour with zero', () => {
    const pdt = Temporal.PlainDateTime.from('2026-06-05T08:05:00');
    const result = t.toDBDateTime(pdt);
    expect(result).toBe('2026-06-05 08:05:00');
  });

  it('handles null input → returns null', () => {
    expect(t.toDBDateTime(null)).toBeNull();
  });

  it('handles undefined input → returns null', () => {
    expect(t.toDBDateTime(undefined)).toBeNull();
  });

  it('converts ZonedDateTime → plain datetime (strips timezone)', () => {
    const zdt = Temporal.ZonedDateTime.from('2026-06-05T13:30:00+03:00[Europe/Istanbul]');
    const result = t.toDBDateTime(zdt);
    expect(result).toBe('2026-06-05 13:30:00');
  });
});

describe('toISODateTime()', () => {
  it('converts Temporal → ISO8601 string with timezone', () => {
    const pdt = Temporal.PlainDateTime.from('2026-06-05T13:30:00');
    const result = t.toISODateTime(pdt);
    expect(result).toContain('2026-06-05T13:30:00');
    expect(result).toContain('Europe/Istanbul');
  });

  it('returns null for null input', () => {
    expect(t.toISODateTime(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(t.toISODateTime(undefined)).toBeNull();
  });
});

describe('fromYmd()', () => {
  it('parses "2026-06-05" → PlainDate with correct values', () => {
    const result = t.fromYmd('2026-06-05');
    expect(result.year).toBe(2026);
    expect(result.month).toBe(6);
    expect(result.day).toBe(5);
  });

  it('handles null input → returns null', () => {
    expect(t.fromYmd(null)).toBeNull();
  });

  it('handles undefined input → returns null', () => {
    expect(t.fromYmd(undefined)).toBeNull();
  });

  it('handles empty string → returns null', () => {
    expect(t.fromYmd('')).toBeNull();
  });
});

describe('toYmd()', () => {
  it('converts PlainDate → "YYYY-MM-DD" string', () => {
    const pd = Temporal.PlainDate.from('2026-06-05');
    expect(t.toYmd(pd)).toBe('2026-06-05');
  });

  it('handles null input → returns empty string', () => {
    expect(t.toYmd(null)).toBe('');
  });

  it('handles undefined input → returns empty string', () => {
    expect(t.toYmd(undefined)).toBe('');
  });
});

describe('fromHHMM()', () => {
  it('parses "13:30" → PlainTime with correct values', () => {
    const result = t.fromHHMM('13:30');
    expect(result.hour).toBe(13);
    expect(result.minute).toBe(30);
  });

  it('parses "09:00" correctly', () => {
    const result = t.fromHHMM('09:00');
    expect(result.hour).toBe(9);
    expect(result.minute).toBe(0);
  });

  it('handles null input → returns null', () => {
    expect(t.fromHHMM(null)).toBeNull();
  });

  it('handles undefined input → returns null', () => {
    expect(t.fromHHMM(undefined)).toBeNull();
  });
});

describe('toHHMM()', () => {
  it('converts PlainTime → "HH:MM" string', () => {
    const pt = Temporal.PlainTime.from({ hour: 13, minute: 30 });
    expect(t.toHHMM(pt)).toBe('13:30');
  });

  it('pads single-digit hour with zero', () => {
    const pt = Temporal.PlainTime.from({ hour: 9, minute: 5 });
    expect(t.toHHMM(pt)).toBe('09:05');
  });

  it('handles null input → returns empty string', () => {
    expect(t.toHHMM(null)).toBe('');
  });

  it('handles undefined input → returns empty string', () => {
    expect(t.toHHMM(undefined)).toBe('');
  });
});

describe('toBusinessZonedDateTime()', () => {
  it('converts PlainDateTime + timezone → ZonedDateTime', () => {
    const pdt = Temporal.PlainDateTime.from('2026-06-05T13:30:00');
    const result = t.toBusinessZonedDateTime(pdt);
    expect(result.timeZoneId).toBe('Europe/Istanbul');
    expect(result.hour).toBe(13);
  });

  it('uses custom timezone when provided', () => {
    const pdt = Temporal.PlainDateTime.from('2026-06-05T13:30:00');
    const result = t.toBusinessZonedDateTime(pdt, 'America/New_York');
    expect(result.timeZoneId).toBe('America/New_York');
  });
});

// ===============================
// CURRENT TIME (these tests use real time - be aware)
// ===============================
describe('now()', () => {
  it('returns a Temporal.ZonedDateTime', () => {
    const result = t.now();
    expect(result).toBeDefined();
    expect(typeof result.hour).toBe('number');
    expect(typeof result.minute).toBe('number');
  });

  it('has correct timezone', () => {
    const result = t.now();
    expect(result.timeZoneId).toBe('Europe/Istanbul');
  });
});

describe('todayYmd()', () => {
  it('returns a string in YYYY-MM-DD format', () => {
    const result = t.todayYmd();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('currentHour()', () => {
  it('returns a number between 0-23', () => {
    const result = t.currentHour();
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(23);
  });
});

describe('currentMinute()', () => {
  it('returns a number between 0-59', () => {
    const result = t.currentMinute();
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(59);
  });
});

describe('currentDayOfWeek()', () => {
  it('returns a number between 1-7 (1=Monday, 7=Sunday)', () => {
    const result = t.currentDayOfWeek();
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(7);
  });
});

// ===============================
// ARITHMETIC
// ===============================
describe('addDaysToYmd()', () => {
  it('adds positive days', () => {
    expect(t.addDaysToYmd('2026-06-05', 7)).toBe('2026-06-12');
  });

  it('subtracts negative days', () => {
    expect(t.addDaysToYmd('2026-06-05', -3)).toBe('2026-06-02');
  });

  it('handles month boundary correctly', () => {
    const result = t.addDaysToYmd('2026-01-30', 5);
    expect(result).toBe('2026-02-04');
  });

  it('handles year boundary', () => {
    const result = t.addDaysToYmd('2026-12-31', 1);
    expect(result).toBe('2027-01-01');
  });

  it('handles leap year February', () => {
    const result = t.addDaysToYmd('2024-02-28', 1);
    expect(result).toBe('2024-02-29');
  });

  it('handles null ymd → returns empty string', () => {
    expect(t.addDaysToYmd(null, 5)).toBe('');
  });

  it('handles null days → treats as 0', () => {
    expect(t.addDaysToYmd('2026-06-05', null)).toBe('2026-06-05');
  });

  it('handles zero days → returns same date', () => {
    expect(t.addDaysToYmd('2026-06-05', 0)).toBe('2026-06-05');
  });
});

describe('addMonthsToYmd()', () => {
  it('adds positive months', () => {
    expect(t.addMonthsToYmd('2026-01-15', 3)).toBe('2026-04-15');
  });

  it('subtracts negative months', () => {
    expect(t.addMonthsToYmd('2026-06-15', -2)).toBe('2026-04-15');
  });

  it('handles month overflow (Jan + 12 = Jan next year)', () => {
    expect(t.addMonthsToYmd('2026-01-15', 12)).toBe('2027-01-15');
  });

  it('handles end-of-month constrain (31 Jan + 1 month = 28 Feb)', () => {
    const result = t.addMonthsToYmd('2026-01-31', 1);
    expect(result).toBe('2026-02-28');
  });

  it('handles null ymd → returns empty string', () => {
    expect(t.addMonthsToYmd(null, 5)).toBe('');
  });
});

describe('addMinutesToTime()', () => {
  it('adds positive minutes', () => {
    expect(t.addMinutesToTime('13:30', 60)).toBe('14:30');
  });

  it('wraps to next hour', () => {
    expect(t.addMinutesToTime('13:45', 30)).toBe('14:15');
  });

  it('wraps past midnight (crosses day boundary)', () => {
    expect(t.addMinutesToTime('23:30', 60)).toBe('00:30');
  });

  it('handles large minute addition', () => {
    expect(t.addMinutesToTime('00:00', 150)).toBe('02:30');
  });

  it('handles null hhmm → returns empty string', () => {
    expect(t.addMinutesToTime(null, 60)).toBe('');
  });

  it('handles null minutes → treats as 0', () => {
    expect(t.addMinutesToTime('13:30', null)).toBe('13:30');
  });
});

describe('diffMinutes()', () => {
  it('calculates positive difference', () => {
    const result = t.diffMinutes('2026-06-05 13:30:00', '2026-06-05 14:45:00');
    expect(result).toBe(75);
  });

  it('calculates negative difference (end before start)', () => {
    const result = t.diffMinutes('2026-06-05 14:45:00', '2026-06-05 13:30:00');
    expect(result).toBe(-75);
  });

  it('returns 0 for same time', () => {
    const result = t.diffMinutes('2026-06-05 13:30:00', '2026-06-05 13:30:00');
    expect(result).toBe(0);
  });

  it('handles Temporal.PlainDateTime input', () => {
    const start = Temporal.PlainDateTime.from('2026-06-05T13:30:00');
    const end = Temporal.PlainDateTime.from('2026-06-05T14:45:00');
    const result = t.diffMinutes(start, end);
    expect(result).toBe(75);
  });

  it('handles cross-hour calculation', () => {
    const result = t.diffMinutes('2026-06-05 13:00:00', '2026-06-05 13:45:00');
    expect(result).toBe(45);
  });
});

describe('lastDayOfMonth()', () => {
  it('returns 31 for January', () => {
    expect(t.lastDayOfMonth(2026, 1)).toBe(31);
  });

  it('returns 28 for February (non-leap year)', () => {
    expect(t.lastDayOfMonth(2026, 2)).toBe(28);
  });

  it('returns 29 for February (leap year 2024)', () => {
    expect(t.lastDayOfMonth(2024, 2)).toBe(29);
  });

  it('returns 30 for April', () => {
    expect(t.lastDayOfMonth(2026, 4)).toBe(30);
  });

  it('returns 30 for June', () => {
    expect(t.lastDayOfMonth(2026, 6)).toBe(30);
  });

  it('returns 31 for December', () => {
    expect(t.lastDayOfMonth(2026, 12)).toBe(31);
  });
});

describe('diffDays()', () => {
  it('calculates positive difference', () => {
    const result = t.diffDays('2026-06-01', '2026-06-30');
    expect(result).toBe(29);
  });

  it('calculates negative difference', () => {
    const result = t.diffDays('2026-06-30', '2026-06-01');
    expect(result).toBe(-29);
  });

  it('returns 0 for same date', () => {
    const result = t.diffDays('2026-06-15', '2026-06-15');
    expect(result).toBe(0);
  });

  it('handles month boundary', () => {
    const result = t.diffDays('2026-05-28', '2026-06-02');
    expect(result).toBe(5);
  });
});

describe('isAfter()', () => {
  it('returns true when ymd is after afterYmd', () => {
    expect(t.isAfter('2026-06-15', '2026-06-10')).toBe(true);
  });

  it('returns false when ymd is before afterYmd', () => {
    expect(t.isAfter('2026-06-05', '2026-06-10')).toBe(false);
  });

  it('returns false when dates are equal', () => {
    expect(t.isAfter('2026-06-10', '2026-06-10')).toBe(false);
  });
});

describe('isBefore()', () => {
  it('returns true when ymd is before beforeYmd', () => {
    expect(t.isBefore('2026-06-05', '2026-06-10')).toBe(true);
  });

  it('returns false when ymd is after beforeYmd', () => {
    expect(t.isBefore('2026-06-15', '2026-06-10')).toBe(false);
  });

  it('returns false when dates are equal', () => {
    expect(t.isBefore('2026-06-10', '2026-06-10')).toBe(false);
  });
});

describe('isBetween()', () => {
  it('returns true when date is within range (exclusive end)', () => {
    expect(t.isBetween('2026-06-15', '2026-06-10', '2026-06-20')).toBe(true);
  });

  it('returns true when date equals start', () => {
    expect(t.isBetween('2026-06-10', '2026-06-10', '2026-06-20')).toBe(true);
  });

  it('returns true when date equals end', () => {
    expect(t.isBetween('2026-06-20', '2026-06-10', '2026-06-20')).toBe(true);
  });

  it('returns false when date is before range', () => {
    expect(t.isBetween('2026-06-05', '2026-06-10', '2026-06-20')).toBe(false);
  });

  it('returns false when date is after range', () => {
    expect(t.isBetween('2026-06-25', '2026-06-10', '2026-06-20')).toBe(false);
  });
});

// ===============================
// SLOT CALCULATIONS
// ===============================
describe('parseHHMMToMinutes()', () => {
  it('parses "13:30" → 810', () => {
    expect(t.parseHHMMToMinutes('13:30')).toBe(810);
  });

  it('parses "09:00" → 540', () => {
    expect(t.parseHHMMToMinutes('09:00')).toBe(540);
  });

  it('parses "00:00" → 0', () => {
    expect(t.parseHHMMToMinutes('00:00')).toBe(0);
  });

  it('parses "23:59" → 1439', () => {
    expect(t.parseHHMMToMinutes('23:59')).toBe(1439);
  });

  it('returns null for invalid format', () => {
    expect(t.parseHHMMToMinutes('invalid')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(t.parseHHMMToMinutes('')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(t.parseHHMMToMinutes(null)).toBeNull();
  });
});

describe('minutesToHHMM()', () => {
  it('converts 810 → "13:30"', () => {
    expect(t.minutesToHHMM(810)).toBe('13:30');
  });

  it('converts 540 → "09:00"', () => {
    expect(t.minutesToHHMM(540)).toBe('09:00');
  });

  it('converts 0 → "00:00"', () => {
    expect(t.minutesToHHMM(0)).toBe('00:00');
  });

  it('converts 1439 → "23:59"', () => {
    expect(t.minutesToHHMM(1439)).toBe('23:59');
  });

  it('pads single-digit hour with zero', () => {
    expect(t.minutesToHHMM(65)).toBe('01:05');
  });
});

describe('buildSlotTimes()', () => {
  it('generates 5-minute slot times for 30 minute duration', () => {
    const result = t.buildSlotTimes('2026-06-05', 570, 30, 5); // 09:30, 30 min
    expect(result.length).toBe(6);
    expect(result[0]).toBe('2026-06-05 09:30:00');
    expect(result[1]).toBe('2026-06-05 09:35:00');
    expect(result[result.length - 1]).toBe('2026-06-05 09:55:00');
  });

  it('generates slots for 60 minute duration', () => {
    const result = t.buildSlotTimes('2026-06-05', 540, 60, 5); // 09:00, 60 min
    expect(result.length).toBe(12);
    expect(result[0]).toBe('2026-06-05 09:00:00');
    expect(result[11]).toBe('2026-06-05 09:55:00');
  });

  it('handles different step sizes', () => {
    const result = t.buildSlotTimes('2026-06-05', 540, 30, 10);
    expect(result.length).toBe(3);
    expect(result[0]).toBe('2026-06-05 09:00:00');
    expect(result[1]).toBe('2026-06-05 09:10:00');
    expect(result[2]).toBe('2026-06-05 09:20:00');
  });
});

describe('getSlotRange()', () => {
  it('returns start and end datetime strings', () => {
    const result = t.getSlotRange('2026-06-05', 570, 60);
    expect(result.start).toBe('2026-06-05 09:30:00');
    expect(result.end).toBe('2026-06-05 10:30:00');
  });

  it('handles end of day times', () => {
    const result = t.getSlotRange('2026-06-05', 1320, 60); // 22:00
    expect(result.start).toBe('2026-06-05 22:00:00');
    expect(result.end).toBe('2026-06-05 23:00:00');
  });
});

// ===============================
// FORMATTING
// ===============================
describe('formatDateTime()', () => {
  it('formats datetime to "DD/MM/YYYY HH:MM" Turkish format', () => {
    const result = t.formatDateTime('2026-06-05 13:30:00');
    expect(result).toBe('05/06/2026 13:30');
  });

  it('pads single-digit day/month with zeros', () => {
    const result = t.formatDateTime('2026-01-05 09:05:00');
    expect(result).toBe('05/01/2026 09:05');
  });

  it('handles Temporal.PlainDateTime input', () => {
    const pdt = Temporal.PlainDateTime.from('2026-06-05T13:30:00');
    const result = t.formatDateTime(pdt);
    expect(result).toBe('05/06/2026 13:30');
  });

  it('returns empty string for null input', () => {
    expect(t.formatDateTime(null)).toBe('');
  });

  it('returns empty string for invalid input', () => {
    expect(t.formatDateTime('invalid-date')).toBe('');
  });
});

describe('formatForDisplay()', () => {
  it('formats datetime with Turkish long format', () => {
    const result = t.formatForDisplay('2026-06-05 13:30:00');
    expect(result).toContain('2026');
    expect(result).toContain('13:30');
  });

  it('handles Temporal.ZonedDateTime input', () => {
    const zdt = Temporal.ZonedDateTime.from('2026-06-05T13:30:00+03:00[Europe/Istanbul]');
    const result = t.formatForDisplay(zdt);
    expect(result).toContain('13:30');
  });

  it('returns empty string for null input', () => {
    expect(t.formatForDisplay(null)).toBe('');
  });
});

describe('formatDate()', () => {
  it('formats date to "DD/MM/YYYY" format', () => {
    expect(t.formatDate('2026-06-05')).toBe('05/06/2026');
  });

  it('handles Temporal.PlainDate input', () => {
    const pd = Temporal.PlainDate.from('2026-06-05');
    expect(t.formatDate(pd)).toBe('05/06/2026');
  });

  it('returns empty string for null input', () => {
    expect(t.formatDate(null)).toBe('');
  });
});

describe('formatTime()', () => {
  it('formats time to "HH:MM" format', () => {
    expect(t.formatTime('13:30')).toBe('13:30');
  });

  it('handles Temporal.PlainTime input', () => {
    const pt = Temporal.PlainTime.from({ hour: 13, minute: 30 });
    expect(t.formatTime(pt)).toBe('13:30');
  });

  it('pads single-digit hour/minute', () => {
    expect(t.formatTime('09:05')).toBe('09:05');
  });

  it('returns empty string for null input', () => {
    expect(t.formatTime(null)).toBe('');
  });
});

describe('toSqlDateTime()', () => {
  it('combines date and time to SQL format', () => {
    expect(t.toSqlDateTime('2026-06-05', '13:30')).toBe('2026-06-05 13:30:00');
  });

  it('handles midnight correctly', () => {
    expect(t.toSqlDateTime('2026-06-05', '00:00')).toBe('2026-06-05 00:00:00');
  });

  it('returns null when dateStr is missing', () => {
    expect(t.toSqlDateTime(null, '13:30')).toBeNull();
  });

  it('returns null when timeStr is missing', () => {
    expect(t.toSqlDateTime('2026-06-05', null)).toBeNull();
  });
});

describe('extractDateTimeParts()', () => {
  it('extracts date and time parts from SQL datetime', () => {
    const result = t.extractDateTimeParts('2026-06-05 13:30:00');
    expect(result.dateStr).toBe('2026-06-05');
    expect(result.timeStr).toBe('13:30');
  });

  it('handles datetime with only date (no time)', () => {
    const result = t.extractDateTimeParts('2026-06-05');
    expect(result.dateStr).toBe('2026-06-05');
    expect(result.timeStr).toBe('');
  });

  it('returns empty strings for null input', () => {
    const result = t.extractDateTimeParts(null);
    expect(result.dateStr).toBe('');
    expect(result.timeStr).toBe('');
  });
});

// ===============================
// VALIDATION
// ===============================
describe('isValidYmd()', () => {
  it('returns true for valid YYYY-MM-DD format', () => {
    expect(t.isValidYmd('2026-06-05')).toBe(true);
  });

  it('returns true for valid date (not just format)', () => {
    expect(t.isValidYmd('2026-02-28')).toBe(true);
  });

  it('returns false for invalid date (Feb 30)', () => {
    expect(t.isValidYmd('2026-02-30')).toBe(false);
  });

  it('returns false for wrong format', () => {
    expect(t.isValidYmd('05-06-2026')).toBe(false);
  });

  it('returns false for null input', () => {
    expect(t.isValidYmd(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(t.isValidYmd('')).toBe(false);
  });
});

describe('isValidHhmm()', () => {
  it('returns true for valid HH:MM format', () => {
    expect(t.isValidHhmm('13:30')).toBe(true);
  });

  it('returns true for "00:00"', () => {
    expect(t.isValidHhmm('00:00')).toBe(true);
  });

  it('returns true for "23:59"', () => {
    expect(t.isValidHhmm('23:59')).toBe(true);
  });

  it('returns false for "24:00" (invalid hour)', () => {
    expect(t.isValidHhmm('24:00')).toBe(false);
  });

  it('returns false for "12:60" (invalid minute)', () => {
    expect(t.isValidHhmm('12:60')).toBe(false);
  });

  it('returns false for null input', () => {
    expect(t.isValidHhmm(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(t.isValidHhmm('')).toBe(false);
  });
});

describe('isWithinBusinessHours()', () => {
  it('returns true for time within business hours', () => {
    expect(t.isWithinBusinessHours('14:00', '09:00', '22:00')).toBe(true);
  });

  it('returns true for time exactly at open', () => {
    expect(t.isWithinBusinessHours('09:00', '09:00', '22:00')).toBe(true);
  });

  it('returns false for time exactly at close', () => {
    expect(t.isWithinBusinessHours('22:00', '09:00', '22:00')).toBe(false);
  });

  it('returns false for time before open', () => {
    expect(t.isWithinBusinessHours('08:00', '09:00', '22:00')).toBe(false);
  });

  it('returns false for time after close', () => {
    expect(t.isWithinBusinessHours('23:00', '09:00', '22:00')).toBe(false);
  });

  it('returns false for invalid time format', () => {
    expect(t.isWithinBusinessHours('invalid', '09:00', '22:00')).toBe(false);
  });

  it('returns false for null time', () => {
    expect(t.isWithinBusinessHours(null, '09:00', '22:00')).toBe(false);
  });
});

describe('compareDateTime()', () => {
  it('returns -1 when a < b', () => {
    expect(t.compareDateTime('2026-06-05 10:00:00', '2026-06-05 14:00:00')).toBe(-1);
  });

  it('returns 1 when a > b', () => {
    expect(t.compareDateTime('2026-06-05 14:00:00', '2026-06-05 10:00:00')).toBe(1);
  });

  it('returns 0 when a === b', () => {
    expect(t.compareDateTime('2026-06-05 10:00:00', '2026-06-05 10:00:00')).toBe(0);
  });

  it('compares dates across different days', () => {
    expect(t.compareDateTime('2026-06-05 10:00:00', '2026-06-06 10:00:00')).toBe(-1);
  });
});

// ===============================
// SPECIAL OPERATIONS
// ===============================
describe('isExpired()', () => {
  it('returns true for past datetime', () => {
    const past = '2020-01-01 00:00:00';
    expect(t.isExpired(past)).toBe(true);
  });

  it('returns true for null input', () => {
    expect(t.isExpired(null)).toBe(true);
  });

  it('returns true for undefined input', () => {
    expect(t.isExpired(undefined)).toBe(true);
  });

  it('returns false for future datetime', () => {
    const future = '2099-12-31 23:59:59';
    expect(t.isExpired(future)).toBe(false);
  });
});

describe('isHoursAgo()', () => {
  it('returns true when target is older than hoursAgo', () => {
    const old = '2020-01-01 00:00:00';
    expect(t.isHoursAgo(old, 1)).toBe(true);
  });

  it('returns false when target is within hoursAgo', () => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    expect(t.isHoursAgo(now, 24)).toBe(false);
  });

  it('returns false for null target', () => {
    expect(t.isHoursAgo(null, 1)).toBe(false);
  });
});

describe('isWithinHours()', () => {
  it('returns true when start is within the specified hours', () => {
    const now = Temporal.Now.zonedDateTimeISO('Europe/Istanbul');
    const future = now.add({ hours: 2 }).toPlainDateTime().toString().replace('T', ' ');
    expect(t.isWithinHours(future.replace('T', ' ').slice(0, 19), 6)).toBe(true);
  });

  it('returns false for null input', () => {
    expect(t.isWithinHours(null, 6)).toBe(false);
  });
});

describe('isWeekend()', () => {
  it('returns true for Saturday (dayOfWeek = 6)', () => {
    expect(t.isWeekend('2026-06-06')).toBe(true); // Saturday
  });

  it('returns true for Sunday (dayOfWeek = 7)', () => {
    expect(t.isWeekend('2026-06-07')).toBe(true); // Sunday
  });

  it('returns false for Monday (dayOfWeek = 1)', () => {
    expect(t.isWeekend('2026-06-01')).toBe(false); // Monday
  });

  it('returns false for Friday (dayOfWeek = 5)', () => {
    expect(t.isWeekend('2026-06-05')).toBe(false); // Friday
  });
});

describe('isWeekday()', () => {
  it('returns true for Monday', () => {
    expect(t.isWeekday('2026-06-01')).toBe(true);
  });

  it('returns true for Friday', () => {
    expect(t.isWeekday('2026-06-05')).toBe(true);
  });

  it('returns false for Saturday', () => {
    expect(t.isWeekday('2026-06-06')).toBe(false);
  });

  it('returns false for Sunday', () => {
    expect(t.isWeekday('2026-06-07')).toBe(false);
  });
});

// ===============================
// CONSTANTS
// ===============================
describe('VIRTUAL_SLOT_MINUTES', () => {
  it('equals 5', () => {
    expect(t.VIRTUAL_SLOT_MINUTES).toBe(5);
  });
});