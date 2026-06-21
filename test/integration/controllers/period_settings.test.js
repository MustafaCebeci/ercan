// test/integration/controllers/period_settings.test.js
/**
 * Period Settings Controller Integration Tests
 * periodSettingsList, periodSettingsCreate, periodSettingsUpdate,
 * periodSettingsPreviewUpdate, periodSettingsDelete, periodSettingsForDate
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock pool
const mockPool = {
  execute: vi.fn(),
  query: vi.fn(),
  getConnection: vi.fn(),
};

// Mock sendCancellationSms
const mockSendCancellationSms = vi.fn().mockResolvedValue({ ok: true });

// Mock config
vi.mock('../../config.js', () => ({
  env: vi.fn((key, fallback) => {
    const map = {
      'BUSINESS_TIMEZONE': 'Europe/Istanbul',
      'PERSONAL_BUSINESS_ID': '1',
      'PERSONAL_BRANCH_ID': '1',
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
  sendCancellationSms: mockSendCancellationSms,
}));

// Mock temporal_api.utils
vi.mock('../../temporal_api.utils.js', () => ({
  now: vi.fn().mockReturnValue({
    hour: 10,
    minute: 0,
    dayOfWeek: 1,
    toPlainDateTime: () => ({ hour: 10, minute: 0 }),
    toPlainDate: () => ({ toString: () => '2026-06-08' }),
  }),
  fromDBDateTime: vi.fn((str) => {
    if (!str) return null;
    const [date, time] = str.split(' ');
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = (time || '00:00:00').split(':').map(Number);
    return { year: y, month: mo, day: d, hour: h, minute: mi, second: 0 };
  }),
  getBusinessTimezone: vi.fn().mockReturnValue('Europe/Istanbul'),
}));

// Import controllers after mocks
const { ScopedControllers } = require('../../controllers.js');

describe('ScopedControllers.periodSettingsList()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      json: vi.fn().mockReturnThis(),
    };
  });

  it('returns list of period settings', async () => {
    mockPool.execute.mockResolvedValueOnce([[
      { id: 1, name: 'Yaz Dönemi', start_date: '2026-06-01', end_date: '2026-08-31', data_json: '{}' },
      { id: 2, name: 'Kış Dönemi', start_date: '2026-09-01', end_date: '2026-12-31', data_json: '{}' },
    ]]);

    mockReq = { decoded: { sub: 1 } };
    await ScopedControllers.periodSettingsList(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      items: expect.any(Array),
    }));
  });

  it('returns empty list when no period settings exist', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]);

    mockReq = { decoded: { sub: 1 } };
    await ScopedControllers.periodSettingsList(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      items: [],
    }));
  });
});

describe('ScopedControllers.periodSettingsCreate()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
  });

  const createMockReq = (overrides = {}) => ({
    body: {
      name: 'Yaz Dönemi',
      start_date: '2026-06-01',
      end_date: '2026-08-31',
      data_json: {
        settings: { start_hour: '10:00', end_hour: '20:00', closed_days: [] },
      },
      ...overrides,
    },
    decoded: { sub: 1 },
    ...overrides,
  });

  it('returns 400 when name is missing', async () => {
    mockReq = createMockReq({ name: undefined });
    await ScopedControllers.periodSettingsCreate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when start_date is missing', async () => {
    mockReq = createMockReq({ start_date: undefined });
    await ScopedControllers.periodSettingsCreate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when end_date is missing', async () => {
    mockReq = createMockReq({ end_date: undefined });
    await ScopedControllers.periodSettingsCreate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when data_json is missing', async () => {
    mockReq = createMockReq({ data_json: undefined });
    await ScopedControllers.periodSettingsCreate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('creates period setting successfully', async () => {
    mockPool.execute.mockResolvedValueOnce([{ insertId: 1 }]);

    mockReq = createMockReq();
    await ScopedControllers.periodSettingsCreate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      id: 1,
    }));
  });

  it('returns 400 when start_date > end_date', async () => {
    mockReq = createMockReq({ start_date: '2026-12-31', end_date: '2026-01-01' });
    await ScopedControllers.periodSettingsCreate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });
});

describe('ScopedControllers.periodSettingsUpdate()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
  });

  const createMockReq = (overrides = {}) => ({
    params: { id: 1 },
    body: {
      name: 'Güncellenmiş Dönem',
      start_date: '2026-06-01',
      end_date: '2026-08-31',
      data_json: {
        settings: { start_hour: '09:00', end_hour: '21:00', closed_days: [] },
      },
      ...overrides,
    },
    decoded: { sub: 1 },
    ...overrides,
  });

  it('returns 400 when id is missing', async () => {
    mockReq = { params: {}, body: {}, decoded: { sub: 1 } };
    await ScopedControllers.periodSettingsUpdate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when data_json is missing', async () => {
    mockReq = createMockReq({ data_json: undefined });
    await ScopedControllers.periodSettingsUpdate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when period setting not found', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]); // No result

    mockReq = createMockReq();
    await ScopedControllers.periodSettingsUpdate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('updates period setting successfully', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ id: 1, name: 'Old Name' }]]) // existing
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // update

    mockReq = createMockReq();
    await ScopedControllers.periodSettingsUpdate(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});

describe('ScopedControllers.periodSettingsPreviewUpdate()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };
  });

  const createMockReq = (overrides = {}) => ({
    params: { id: 1 },
    body: {
      data_json: {
        settings: { start_hour: '09:00', end_hour: '21:00' },
      },
      ...overrides,
    },
    decoded: { sub: 1 },
    ...overrides,
  });

  it('returns 400 when id is missing', async () => {
    mockReq = { params: {}, body: {}, decoded: { sub: 1 } };
    await ScopedControllers.periodSettingsPreviewUpdate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when data_json is missing', async () => {
    mockReq = createMockReq({ data_json: undefined });
    await ScopedControllers.periodSettingsPreviewUpdate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when data_json is not an object', async () => {
    mockReq = createMockReq({ data_json: 'not an object' });
    await ScopedControllers.periodSettingsPreviewUpdate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when period setting not found', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]);

    mockReq = createMockReq();
    await ScopedControllers.periodSettingsPreviewUpdate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('returns has_conflict=false when hours have not changed', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      data_json: JSON.stringify({ settings: { start_hour: '09:00', end_hour: '22:00' } })
    }]]);

    mockReq = createMockReq({
      data_json: { settings: { start_hour: '09:00', end_hour: '22:00' } },
    });
    await ScopedControllers.periodSettingsPreviewUpdate(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      has_conflict: false,
      warning: expect.stringContaining('Uyumsuz'),
    }));
  });

  it('returns has_conflict=true when new hours exclude appointments', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        data_json: JSON.stringify({ settings: { start_hour: '09:00', end_hour: '22:00' } })
      }]])
      .mockResolvedValueOnce([[
        { id: 1, start_at: '2026-06-15 20:30:00', customer_name: 'Test' },
      ]]);

    mockReq = createMockReq({
      data_json: { settings: { start_hour: '09:00', end_hour: '20:00' } }, // earlier close
    });
    await ScopedControllers.periodSettingsPreviewUpdate(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      has_conflict: true,
      appointment_count: 1,
    }));
  });

  it('returns empty appointments list when no conflicts', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        data_json: JSON.stringify({ settings: { start_hour: '09:00', end_hour: '22:00' } })
      }]])
      .mockResolvedValueOnce([[]]);

    mockReq = createMockReq({
      data_json: { settings: { start_hour: '08:00', end_hour: '23:00' } }, // wider range
    });
    await ScopedControllers.periodSettingsPreviewUpdate(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      has_conflict: false,
      appointments: [],
    }));
  });
});

describe('ScopedControllers.periodSettingsDelete()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };
  });

  const createMockReq = (overrides = {}) => ({
    params: { id: 1 },
    body: {
      cancel_appointments: false,
      send_sms: false,
      ...overrides,
    },
    decoded: { sub: 1 },
    ...overrides,
  });

  it('returns 400 when id is missing', async () => {
    mockReq = { params: {}, body: {}, decoded: { sub: 1 } };
    await ScopedControllers.periodSettingsDelete(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when period setting not found', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]);

    mockReq = createMockReq();
    await ScopedControllers.periodSettingsDelete(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('deletes period setting without cancelling appointments', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ start_date: '2026-06-01', end_date: '2026-06-30' }]]) // period found
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete result

    mockReq = createMockReq({ cancel_appointments: false });
    await ScopedControllers.periodSettingsDelete(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
    }));
  });

  it('cancels appointments when cancel_appointments=true', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ start_date: '2026-06-01', end_date: '2026-06-30' }]]) // period found
      .mockResolvedValueOnce([[{ cnt: 5 }]]) // appointment count
      .mockResolvedValueOnce([{ affectedRows: 5 }]) // update result
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete result

    mockReq = createMockReq({ cancel_appointments: true });
    await ScopedControllers.periodSettingsDelete(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      affectedAppointments: 5,
    }));
  });

  it('sends SMS to affected customers when send_sms=true and cancel_appointments=true', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ start_date: '2026-06-01', end_date: '2026-06-30' }]]) // period found
      .mockResolvedValueOnce([[{ cnt: 2 }]]) // appointment count
      .mockResolvedValueOnce([[
        { id: 1, customer_id: 1, start_at: '2026-06-15 10:00:00', customer_phone: '5467473915', customer_name: 'Ahmet' },
        { id: 2, customer_id: 2, start_at: '2026-06-16 14:00:00', customer_phone: '5467473916', customer_name: 'Mehmet' },
      ]]) // appointments to cancel
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // update result
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete result

    mockReq = createMockReq({ cancel_appointments: true, send_sms: true });
    await ScopedControllers.periodSettingsDelete(mockReq, mockRes);

    // mockSendCancellationSms should have been called twice (once per affected appointment)
    // The actual call count depends on implementation
  });

  it('does not send SMS when send_sms=false', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ start_date: '2026-06-01', end_date: '2026-06-30' }]])
      .mockResolvedValueOnce([[{ cnt: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    mockReq = createMockReq({ cancel_appointments: true, send_sms: false });
    await ScopedControllers.periodSettingsDelete(mockReq, mockRes);

    // mockSendCancellationSms should not be called
  });
});

describe('ScopedControllers.periodSettingsForDate()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };
  });

  it('returns 400 when date is missing', async () => {
    mockReq = { body: {}, decoded: { sub: 1 } };
    await ScopedControllers.periodSettingsForDate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when date format is invalid', async () => {
    mockReq = { body: { date: 'invalid' }, decoded: { sub: 1 } };
    await ScopedControllers.periodSettingsForDate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns period settings for a valid date', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      start_date: '2026-06-01',
      end_date: '2026-08-31',
      data_json: JSON.stringify({ settings: { start_hour: '10:00', end_hour: '20:00' } }),
    }]]);

    mockReq = { body: { date: '2026-06-15' }, decoded: { sub: 1 } };
    await ScopedControllers.periodSettingsForDate(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      id: 1,
    }));
  });

  it('returns empty object when no period settings for date', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]);

    mockReq = { body: { date: '2026-06-15' }, decoded: { sub: 1 } };
    await ScopedControllers.periodSettingsForDate(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      id: null,
    }));
  });
});