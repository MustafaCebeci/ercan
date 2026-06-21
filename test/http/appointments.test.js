// test/http/appointments.test.js
/**
 * HTTP Integration Tests - Appointments endpoints
 * Tests /appointments/* routes using supertest
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';

// Mock pool before importing app
const mockPool = {
  execute: vi.fn(),
  query: vi.fn(),
  getConnection: vi.fn(),
};

// Mock notification service
const mockSendSms = vi.fn().mockResolvedValue({ status: true });
const mockSendCancellationSms = vi.fn().mockResolvedValue({ ok: true });

// Mock config
vi.mock('../config.js', () => ({
  env: vi.fn((key, fallback) => {
    const map = {
      'BUSINESS_TIMEZONE': 'Europe/Istanbul',
      'PERSONAL_BUSINESS_ID': '1',
      'PERSONAL_BRANCH_ID': '1',
      'JWT_SECRET': 'test-secret-key',
      'CRON_SECRET': 'cron-secret',
    };
    return map[key] ?? fallback;
  }),
  getMailer: vi.fn().mockResolvedValue({ sendMail: vi.fn() }),
}));

// Mock models
vi.mock('../models.js', () => ({
  pool: mockPool,
}));

// Mock notification.service
vi.mock('../notification.service.js', () => ({
  sendSms: mockSendSms,
  sendCancellationSms: mockSendCancellationSms,
  sendOtp: vi.fn().mockResolvedValue({ ok: true, codeSent: '123456' }),
  verifyOtp: vi.fn().mockResolvedValue({ ok: true }),
}));

// Mock temporal_api.utils
vi.mock('../temporal_api.utils.js', () => ({
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
  VIRTUAL_SLOT_MINUTES: 5,
  getBusinessTimezone: vi.fn().mockReturnValue('Europe/Istanbul'),
}));

// Mock bcrypt
vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn().mockImplementation((password, hash) => {
      return Promise.resolve(password === 'test123');
    }),
  },
}));

// Import app after mocks
const app = require('../app.js');

describe('POST /appointments/book', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app)
      .post('/appointments/book')
      .send({
        staffId: 1,
        serviceId: 1,
        date: '2026-06-10',
        time: '10:00',
      });

    expect(res.status).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    // Login first to get token
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Test User',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;
    expect(token).toBeDefined();

    // Now try to book without required fields
    const res = await request(app)
      .post('/appointments/book')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 when date format is invalid', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Test User',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute.mockResolvedValueOnce([[]]); // customer_flags
    mockPool.execute.mockResolvedValueOnce([[{ settings_json: '{}' }]]); // business settings

    const res = await request(app)
      .post('/appointments/book')
      .set('Authorization', `Bearer ${token}`)
      .send({
        staffId: 1,
        serviceId: 1,
        date: 'invalid-date',
        time: '10:00',
      });

    expect(res.status).toBe(400);
  });

  it('returns 201 when booking is successful', async () => {
    // Login
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Test User',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    // Mock all the queries for booking
    mockPool.execute
      .mockResolvedValueOnce([[]]) // customer_flags - not blacklisted
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({ start_hour: '09:00', end_hour: '22:00' }) }]]) // business settings
      .mockResolvedValueOnce([[{ id: 1, name: 'Service', is_active: 1, duration_minutes: 60, price: 100 }]]) // service
      .mockResolvedValueOnce([[{ id: 1, name: 'Staff' }]]) // staff
      .mockResolvedValueOnce([[{ id: 1, name: 'Provider', is_active: 1, provider_type: 'barber' }]]) // provider
      .mockResolvedValueOnce([[{ id: 1 }]]) // provider_services
      .mockResolvedValueOnce([[]]) // no closure
      .mockResolvedValueOnce([[{ settings_json: '{}' }]]); // app_settings

    const mockConn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{ insertId: 123 }]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    mockPool.getConnection.mockResolvedValue(mockConn);

    const res = await request(app)
      .post('/appointments/book')
      .set('Authorization', `Bearer ${token}`)
      .send({
        staffId: 1,
        serviceId: 1,
        date: '2026-06-10',
        time: '10:00',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /appointments/slots/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app)
      .post('/appointments/slots/generate')
      .send({ date: '2026-06-10', staffId: 1 });

    expect(res.status).toBe(401);
  });

  it('returns slots for valid request', async () => {
    // Login
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Test User',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({ start_hour: '09:00', end_hour: '22:00', slot_time: 60 }) }]]) // business settings
      .mockResolvedValueOnce([[]]) // no period settings
      .mockResolvedValueOnce([[{ id: 1, duration_minutes: 60 }]]) // service
      .mockResolvedValueOnce([[]]) // no appointment_slots
      .mockResolvedValueOnce([[]]) // no appointments fallback
      .mockResolvedValueOnce([[]]); // no closures

    const res = await request(app)
      .post('/appointments/slots/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ date: '2026-06-10', staffId: 1, serviceId: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
  });

  it('returns 400 for invalid date format', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Test User',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    const res = await request(app)
      .post('/appointments/slots/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ date: 'invalid', staffId: 1 });

    expect(res.status).toBe(400);
  });
});

describe('POST /appointments/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when appointment_id is missing', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Test User',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    const res = await request(app)
      .post('/appointments/cancel')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 200 when cancellation is successful', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Test User',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute
      .mockResolvedValueOnce([[{ customer_id: 1, status: 'confirmed' }]]) // appointment found
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // update result

    const mockConn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{}]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    mockPool.getConnection.mockResolvedValue(mockConn);

    const res = await request(app)
      .post('/appointments/cancel')
      .set('Authorization', `Bearer ${token}`)
      .send({ appointment_id: 1 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /appointments/panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).get('/appointments/panel');
    expect(res.status).toBe(401);
  });

  it('returns panel appointments when authenticated', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Test User',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute.mockResolvedValueOnce([[
      { id: 1, start_at: '2026-06-10 10:00:00', customer_name: 'Test', service_name: 'Haircut' },
    ]]);

    const res = await request(app)
      .get('/appointments/panel')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
  });
});

describe('POST /appointments/can-book', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app)
      .post('/appointments/can-book')
      .send({ staffId: 1, date: '2026-06-10', time: '10:00' });

    expect(res.status).toBe(401);
  });

  it('returns availability check result', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Test User',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute.mockResolvedValueOnce([[]]); // no conflicts

    const res = await request(app)
      .post('/appointments/can-book')
      .set('Authorization', `Bearer ${token}`)
      .send({ staffId: 1, date: '2026-06-10', time: '10:00' });

    expect(res.status).toBe(200);
  });
});