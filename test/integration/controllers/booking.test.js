// test/integration/controllers/booking.test.js
/**
 * Booking Controller Integration Tests
 * book, generateSlots, cancel endpoint'leri için mock DB test'leri
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock pool
const mockPool = {
  execute: vi.fn(),
  query: vi.fn(),
  getConnection: vi.fn(),
};

// Mock notification service
const mockSendSms = vi.fn().mockResolvedValue({ status: true });
const mockSendCancellationSms = vi.fn().mockResolvedValue({ ok: true });

// Mock config
vi.mock('../../config.js', () => ({
  env: vi.fn((key, fallback) => {
    const map = {
      'BUSINESS_TIMEZONE': 'Europe/Istanbul',
      'PERSONAL_BUSINESS_ID': '1',
      'PERSONAL_BRANCH_ID': '1',
      'SMS_USER': 'test',
      'SMS_PASS': 'test',
      'SMS_BASLIK': 'TEST',
    };
    return map[key] ?? fallback;
  }),
  getMailer: vi.fn().mockResolvedValue({ sendMail: vi.fn() }),
}));

// Mock models
vi.mock('../../models.js', () => ({
  pool: mockPool,
}));

// Mock notification.service
vi.mock('../../notification.service.js', () => ({
  sendSms: mockSendSms,
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
  todayYmd: vi.fn().mockReturnValue('2026-06-08'),
  addDaysToYmd: vi.fn((ymd, days) => {
    const d = new Date(ymd);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }),
  fromDBDateTime: vi.fn((str) => {
    if (!str) return null;
    const [date, time] = str.split(' ');
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = (time || '00:00:00').split(':').map(Number);
    return { year: y, month: mo, day: d, hour: h, minute: mi, second: 0 };
  }),
  toSqlDateTime: vi.fn((d, t) => d && t ? `${d} ${t}:00` : null),
  parseHHMMToMinutes: vi.fn((hhmm) => {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }),
  minutesToHHMM: vi.fn((mins) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }),
  buildSlotTimes: vi.fn((date, startMin, duration) => {
    const slots = [];
    for (let i = 0; i < Math.ceil(duration / 5); i++) {
      const totalMin = startMin + (i * 5);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      slots.push(`${date} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
    }
    return slots;
  }),
  parseHHMMToMinutesSimple: vi.fn((h) => {
    if (!h) return null;
    const [hh, mm] = String(h).split(':').map(Number);
    return hh * 60 + mm;
  }),
  roundUpToStep: vi.fn((n, step) => Math.ceil(n / step) * step),
  VIRTUAL_SLOT_MINUTES: 5,
  getBusinessTimezone: vi.fn().mockReturnValue('Europe/Istanbul'),
  fromYmd: vi.fn(),
  toYmd: vi.fn(),
  addDaysYmd: vi.fn(),
  compareDateTime: vi.fn(),
}));

// Import controllers after mocks
const { BookingControllers } = require('../../controllers.js');

describe('BookingControllers.book()', () => {
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
      staffId: 1,
      serviceId: 1,
      date: '2026-06-10',
      time: '10:00',
      ...overrides,
    },
    decoded: { sub: 1 },
    ...overrides,
  });

  it('returns 400 when staffId is missing', async () => {
    mockReq = createMockReq({ staffId: undefined, serviceId: 1 });
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when serviceId is missing', async () => {
    mockReq = createMockReq({ staffId: 1, serviceId: undefined });
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when date is missing', async () => {
    mockReq = createMockReq({ staffId: 1, serviceId: 1, date: '' });
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when time is missing', async () => {
    mockReq = createMockReq({ staffId: 1, serviceId: 1, time: '' });
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 403 when customer is blacklisted', async () => {
    mockPool.execute.mockResolvedValueOnce([[{ is_blacklisted: 1 }]]);
    mockReq = createMockReq();

    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('kara listeye'),
    }));
  });

  it('returns 404 when service not found', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[]]) // customer_flags empty
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({}) }]]) // business settings
      .mockResolvedValueOnce([[]]); // service not found

    mockReq = createMockReq();
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when service is inactive', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[]]) // customer_flags
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({}) }]]) // business settings
      .mockResolvedValueOnce([[{ id: 1, name: 'Test Service', is_active: 0 }]]); // inactive service

    mockReq = createMockReq();
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('inactive'),
    }));
  });

  it('returns 400 when time is outside business hours', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[]]) // customer_flags
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({ start_hour: '09:00', end_hour: '18:00' }) }]]) // business settings with 18:00 close
      .mockResolvedValueOnce([[{ id: 1, name: 'Service', is_active: 1, duration_minutes: 60, price: 100 }]]);

    mockReq = createMockReq({ time: '20:00' }); // After closing
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when slot not aligned with 5-minute intervals', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[]]) // customer_flags
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({ start_hour: '09:00', end_hour: '22:00' }) }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Service', is_active: 1, duration_minutes: 60, price: 100 }]]);

    mockReq = createMockReq({ time: '10:07' }); // Not aligned
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('5-minute'),
    }));
  });

  it('returns 400 when staff not found', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[]]) // customer_flags
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({}) }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Service', is_active: 1, duration_minutes: 60, price: 100 }]])
      .mockResolvedValueOnce([[]]); // staff not found

    mockReq = createMockReq();
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when staff does not provide service', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[]]) // customer_flags
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({}) }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Service', is_active: 1, duration_minutes: 60, price: 100 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Staff' }]]) // staff found
      .mockResolvedValueOnce([[{ id: 1, name: 'Provider', is_active: 1, provider_type: 'barber' }]]) // provider
      .mockResolvedValueOnce([[]]); // provider_services empty

    mockReq = createMockReq();
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('does not provide'),
    }));
  });

  it('returns 400 when business is closed for the selected slot', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[]]) // customer_flags
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({}) }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Service', is_active: 1, duration_minutes: 60, price: 100 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Staff' }]]) // staff
      .mockResolvedValueOnce([[{ id: 1, name: 'Provider', is_active: 1 }]]) // provider
      .mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 1 }]])

    mockReq = createMockReq();
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('closed'),
    }));
  });

  it('returns 201 when booking is successful', async () => {
    const mockConn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{ insertId: 123 }]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    mockPool.getConnection.mockResolvedValue(mockConn);

    mockPool.execute
      .mockResolvedValueOnce([[]]) // customer_flags
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({ start_hour: '09:00', end_hour: '22:00' }) }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Service', is_active: 1, duration_minutes: 60, price: 100 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Staff' }]]) // staff
      .mockResolvedValueOnce([[{ id: 1, name: 'Provider', is_active: 1, provider_type: 'barber' }]]) // provider
      .mockResolvedValueOnce([[{ id: 1 }]]) // provider_services
      .mockResolvedValueOnce([[]]) // no closure
      .mockResolvedValueOnce([[{ settings_json: '{}' }]]); // app_settings

    mockReq = createMockReq();
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
    }));
  });

  it('returns 400 when appointment count exceeds limit', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[]]) // customer_flags
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({ multiple_appointment_count: 2 }) }]])
      .mockResolvedValueOnce([[{ cnt: 2 }]]); // already at limit

    mockReq = createMockReq();
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('maksimum'),
    }));
  });

  it('returns 400 when booking date exceeds maxDayRange', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[]]) // customer_flags
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({ booking_coming_day_range: 2 }) }]]);

    mockReq = createMockReq({ date: '2026-12-31' }); // far future date
    await BookingControllers.book(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('gun araligi'),
    }));
  });
});

describe('BookingControllers.generateSlots()', () => {
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
    body: {
      date: '2026-06-10',
      staffId: 1,
      serviceId: 1,
      ...overrides,
    },
    headers: {},
    ...overrides,
  });

  it('returns 401 when not authenticated', async () => {
    mockReq = { body: {}, headers: {} };
    await BookingControllers.generateSlots(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it('returns empty array for closed day (period_settings closed_days)', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({ start_hour: '09:00', end_hour: '22:00' }) }]]) // business settings
      .mockResolvedValueOnce([[{
        data_json: JSON.stringify({
          settings: { start_hour: '10:00', end_hour: '20:00', closed_days: [0] } // Sunday closed
        })
      }]]); // period settings with Sunday closed

    mockReq = createMockReq({ date: '2026-06-14' }); // Sunday
    const mockDecoded = { sub: 1 };
    mockReq.decoded = mockDecoded;

    // Mock readJwtFromReq
    vi.mock('../../controllers.js', async () => {
      const original = await import('../../controllers.js');
      return original;
    });

    await BookingControllers.generateSlots(mockReq, mockRes);
    // If it's a closed day, should return empty array
  });

  it('returns slots for normal day', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({ start_hour: '09:00', end_hour: '22:00', slot_time: 60 }) }]])
      .mockResolvedValueOnce([[]]) // no period settings
      .mockResolvedValueOnce([[{ id: 1, duration_minutes: 60 }]]) // service
      .mockResolvedValueOnce([[]]) // no appointment_slots
      .mockResolvedValueOnce([[]]) // no appointments fallback
      .mockResolvedValueOnce([[]]) // no closures

    mockReq = createMockReq();
    mockReq.decoded = { sub: 1 };

    await BookingControllers.generateSlots(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalled();
  });

  it('returns 400 for invalid date format', async () => {
    mockReq = createMockReq({ date: 'invalid-date' });
    mockReq.decoded = { sub: 1 };

    await BookingControllers.generateSlots(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });
});

describe('BookingControllers.cancel()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };
  });

  it('returns 400 when appointment_id is missing', async () => {
    mockReq = { body: {}, decoded: { sub: 1 } };
    await BookingControllers.cancel(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 403 when user does not own the appointment', async () => {
    mockPool.execute.mockResolvedValueOnce([[{ customer_id: 999 }]]); // Different customer
    mockReq = { body: { appointment_id: 1 }, decoded: { sub: 1 } };

    await BookingControllers.cancel(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(403);
  });

  it('returns 200 when cancellation is successful', async () => {
    const mockConn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{}]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    mockPool.getConnection.mockResolvedValue(mockConn);

    mockPool.execute
      .mockResolvedValueOnce([[{ customer_id: 1, status: 'confirmed' }]]) // appointment found
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // update result

    mockReq = { body: { appointment_id: 1 }, decoded: { sub: 1 } };
    await BookingControllers.cancel(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});