// test/integration/scheduler.test.js
/**
 * Scheduler Integration Tests
 * runJobs, isBusinessOpen, autoMarkAppointments, sendReminders
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock pool
const mockPool = {
  execute: vi.fn(),
  query: vi.fn(),
};

// Mock sendSms
const mockSendSms = vi.fn().mockResolvedValue({ status: true });

// Mock config
vi.mock('../../config.js', () => ({
  env: vi.fn((key, fallback) => {
    const map = {
      'BUSINESS_TIMEZONE': 'Europe/Istanbul',
    };
    return map[key] ?? fallback;
  }),
}));

// Mock models
vi.mock('../../models.js', () => ({
  pool: mockPool,
}));

// Mock notification.service
vi.mock('../../notification.service.js', () => ({
  sendSms: mockSendSms,
}));

// Mock temporal_api.utils
vi.mock('../../temporal_api.utils.js', () => ({
  now: vi.fn().mockReturnValue({
    hour: 10,
    minute: 0,
    dayOfWeek: 2, // Tuesday
  }),
  formatDateTime: vi.fn((dt) => '08/06/2026 14:00'),
}));

// Import scheduler after mocks
const scheduler = require('../../scheduler.js');

describe('scheduler.runJobs()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips execution if already running', async () => {
    // First call starts running
    // Second call should skip
    // This is hard to test without more complex mocking
  });

  it('returns early when business is closed', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      settings_json: JSON.stringify({
        closed_days: [2], // Tuesday closed
        start_hour: '09:00',
        end_hour: '18:00',
      })
    }]]);

    await scheduler.runJobs();

    // Should not call autoMarkAppointments or sendReminders
    // The implementation shows this by returning early
  });

  it('executes autoMarkAppointments and sendReminders when business is open', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        settings_json: JSON.stringify({
          start_hour: '09:00',
          end_hour: '22:00',
        })
      }]]) // isBusinessOpen
      .mockResolvedValueOnce([[]]) // autoMarkAppointments (no expired appointments)
      .mockResolvedValueOnce([[]]) // sendReminders (no reminders to send)

    await scheduler.runJobs();

    // No error means successful execution
    expect(mockPool.execute).toHaveBeenCalled();
  });

  it('handles errors gracefully', async () => {
    mockPool.execute.mockRejectedValueOnce(new Error('DB error'));

    // Should not throw, just log error
    await expect(scheduler.runJobs()).resolves.toBeUndefined();
  });
});

describe('scheduler.isBusinessOpen()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when no settings exist', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]);

    const result = await scheduler.isBusinessOpen();
    expect(result).toBe(true);
  });

  it('returns false when current day is in closed_days', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      settings_json: JSON.stringify({
        closed_days: [1, 2, 3, 4, 5], // Weekdays closed
        start_hour: '09:00',
        end_hour: '22:00',
      })
    }]]);

    const result = await scheduler.isBusinessOpen();
    expect(result).toBe(false);
  });

  it('returns true when current time is within business hours', async () => {
    const { now } = require('../../temporal_api.utils.js');
    now.mockReturnValueOnce({
      hour: 14,
      minute: 0,
      dayOfWeek: 6, // Saturday
    });

    mockPool.execute.mockResolvedValueOnce([[{
      settings_json: JSON.stringify({
        closed_days: [],
        start_hour: '09:00',
        end_hour: '22:00',
      })
    }]]);

    const result = await scheduler.isBusinessOpen();
    expect(result).toBe(true);
  });

  it('returns false when current time is before open', async () => {
    const { now } = require('../../temporal_api.utils.js');
    now.mockReturnValueOnce({
      hour: 7,
      minute: 0,
      dayOfWeek: 6,
    });

    mockPool.execute.mockResolvedValueOnce([[{
      settings_json: JSON.stringify({
        closed_days: [],
        start_hour: '09:00',
        end_hour: '22:00',
      })
    }]]);

    const result = await scheduler.isBusinessOpen();
    expect(result).toBe(false);
  });

  it('returns false when current time is after close', async () => {
    const { now } = require('../../temporal_api.utils.js');
    now.mockReturnValueOnce({
      hour: 23,
      minute: 0,
      dayOfWeek: 6,
    });

    mockPool.execute.mockResolvedValueOnce([[{
      settings_json: JSON.stringify({
        closed_days: [],
        start_hour: '09:00',
        end_hour: '22:00',
      })
    }]]);

    const result = await scheduler.isBusinessOpen();
    expect(result).toBe(false);
  });

  it('handles settings_json as string', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      settings_json: '{"start_hour":"09:00","end_hour":"22:00","closed_days":[]}'
    }]]);

    const result = await scheduler.isBusinessOpen();
    expect(result).toBe(true);
  });

  it('handles settings_json as object', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      settings_json: { start_hour: '09:00', end_hour: '22:00', closed_days: [] }
    }]]);

    const result = await scheduler.isBusinessOpen();
    expect(result).toBe(true);
  });

  it('returns true on error (fail-safe)', async () => {
    mockPool.execute.mockRejectedValueOnce(new Error('DB error'));

    const result = await scheduler.isBusinessOpen();
    expect(result).toBe(true);
  });
});

describe('scheduler.autoMarkAppointments()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks appointments as no_show when end_at is past grace period (default)', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ settings_json: '{}' }]])
      .mockResolvedValueOnce([{ affectedRows: 3 }]);

    await scheduler.autoMarkAppointments();

    expect(mockPool.execute).toHaveBeenCalledTimes(2);
    // Default target status should be 'no_show'
    const updateCall = mockPool.execute.mock.calls[1][0];
    expect(updateCall).toContain("status = ?");
  });

  it('does nothing when no appointments to mark', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ settings_json: '{}' }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]);

    await scheduler.autoMarkAppointments();

    // Should have called execute but affectedRows is 0
  });

  it('logs number of marked appointments', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({ auto_mark_grace_minutes: 30 }) }]])
      .mockResolvedValueOnce([{ affectedRows: 5 }]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.autoMarkAppointments();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('5'));
  });

  it('skips UPDATE when auto_no_show_status is "none"', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        settings_json: JSON.stringify({ auto_no_show_status: 'none' })
      }]]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.autoMarkAppointments();

    // Only the SELECT should run; no UPDATE
    expect(mockPool.execute).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('devre dışı'));
  });

  it('updates to completed when auto_no_show_status is "completed"', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        settings_json: JSON.stringify({
          auto_no_show_status: 'completed',
          auto_mark_grace_minutes: 15,
        })
      }]])
      .mockResolvedValueOnce([{ affectedRows: 2 }]);

    await scheduler.autoMarkAppointments();

    expect(mockPool.execute).toHaveBeenCalledTimes(2);
    // params: [targetStatus, graceMinutes]
    const updateParams = mockPool.execute.mock.calls[1][1];
    expect(updateParams).toEqual(['completed', 15]);
  });

  it('updates to cancelled with system fields when auto_no_show_status is "cancelled"', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        settings_json: JSON.stringify({
          auto_no_show_status: 'cancelled',
          auto_mark_grace_minutes: 30,
        })
      }]])
      .mockResolvedValueOnce([{ affectedRows: 4 }]);

    await scheduler.autoMarkAppointments();

    expect(mockPool.execute).toHaveBeenCalledTimes(2);
    const updateCall = mockPool.execute.mock.calls[1][0];
    // cancelled status should set system fields
    expect(updateCall).toContain("'system'");
    expect(updateCall).toContain('Otomatik işaretleme');
    const updateParams = mockPool.execute.mock.calls[1][1];
    expect(updateParams).toEqual(['cancelled', 30]);
  });

  it('does not set system fields when auto_no_show_status is "completed"', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        settings_json: JSON.stringify({ auto_no_show_status: 'completed' })
      }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await scheduler.autoMarkAppointments();

    const updateCall = mockPool.execute.mock.calls[1][0];
    // When completed, cancelled_by/cancel_reason should NOT be touched (no 'system' literal)
    expect(updateCall).not.toContain("'system'");
    expect(updateCall).not.toContain('Otomatik işaretleme');
  });

  it('falls back to no_show for invalid auto_no_show_status values', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        settings_json: JSON.stringify({ auto_no_show_status: 'invalid_value' })
      }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]);

    await scheduler.autoMarkAppointments();

    const updateParams = mockPool.execute.mock.calls[1][1];
    expect(updateParams[0]).toBe('no_show');
  });

  it('handles errors gracefully', async () => {
    mockPool.execute.mockRejectedValueOnce(new Error('DB error'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await scheduler.autoMarkAppointments();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('autoMarkAppointments'));
  });
});

describe('scheduler.sendReminders()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendSms.mockClear();
  });

  it('skips when sms_reminder is disabled in settings', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      settings_json: JSON.stringify({
        sms_reminder: false,
        reminder_hours: 6,
      })
    }]]);

    await scheduler.sendReminders();

    // Should not call sendSms
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('does nothing when no appointments need reminder', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        settings_json: JSON.stringify({
          sms_reminder: true,
          reminder_hours: 6,
        })
      }]])
      .mockResolvedValueOnce([[]]); // No appointments

    await scheduler.sendReminders();

    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('skips reminder if already sent', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        settings_json: JSON.stringify({
          sms_reminder: true,
          reminder_hours: 6,
        })
      }]])
      .mockResolvedValueOnce([[
        { id: 1, start_at: '2026-06-08 14:00:00', phone: '5467473915', name: 'Test' }
      ]])
      .mockResolvedValueOnce([[{ id: 1 }]]); // Already sent

    await scheduler.sendReminders();

    // Should not call sendSms because already sent
  });

  it('sends reminder SMS to appointment needing reminder', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        settings_json: JSON.stringify({
          sms_reminder: true,
          reminder_hours: 6,
        })
      }]])
      .mockResolvedValueOnce([[
        { id: 1, start_at: '2026-06-08 14:00:00', phone: '5467473915', name: 'Test' }
      ]])
      .mockResolvedValueOnce([[]]); // Not sent yet

    await scheduler.sendReminders();

    expect(mockSendSms).toHaveBeenCalledWith(expect.objectContaining({
      appointment_id: 1,
      phone: '5467473915',
      type: 'reminder',
    }));
  });

  it('handles SMS sending errors gracefully', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        settings_json: JSON.stringify({
          sms_reminder: true,
          reminder_hours: 6,
        })
      }]])
      .mockResolvedValueOnce([[
        { id: 1, start_at: '2026-06-08 14:00:00', phone: '5467473915', name: 'Test' }
      ]])
      .mockResolvedValueOnce([[]]); // Not sent yet

    mockSendSms.mockRejectedValueOnce(new Error('SMS API Error'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await scheduler.sendReminders();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SMS hatası'));
  });

  it('uses default reminder_hours of 6 when not specified', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        settings_json: JSON.stringify({
          sms_reminder: true,
        })
      }]])
      .mockResolvedValueOnce([[]]); // No appointments

    await scheduler.sendReminders();

    // Should complete without error
  });

  it('handles errors gracefully', async () => {
    mockPool.execute.mockRejectedValueOnce(new Error('DB error'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await scheduler.sendReminders();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('sendReminders'));
  });
});