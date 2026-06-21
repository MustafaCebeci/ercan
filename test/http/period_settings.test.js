// test/http/period_settings.test.js
/**
 * HTTP Integration Tests - Period Settings endpoints
 * Tests /period_settings/* routes using supertest
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mock pool
const mockPool = {
  execute: vi.fn(),
  query: vi.fn(),
  getConnection: vi.fn(),
};

// Mock notification service
const mockSendCancellationSms = vi.fn().mockResolvedValue({ ok: true });

// Mock config
vi.mock('../config.js', () => ({
  env: vi.fn((key, fallback) => {
    const map = {
      'BUSINESS_TIMEZONE': 'Europe/Istanbul',
      'PERSONAL_BUSINESS_ID': '1',
      'PERSONAL_BRANCH_ID': '1',
      'JWT_SECRET': 'test-secret-key',
    };
    return map[key] ?? fallback;
  }),
}));

// Mock models
vi.mock('../models.js', () => ({
  pool: mockPool,
}));

// Mock notification.service
vi.mock('../notification.service.js', () => ({
  sendCancellationSms: mockSendCancellationSms,
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
  fromDBDateTime: vi.fn((str) => {
    if (!str) return null;
    const [date, time] = str.split(' ');
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = (time || '00:00:00').split(':').map(Number);
    return { year: y, month: mo, day: d, hour: h, minute: mi, second: 0 };
  }),
  getBusinessTimezone: vi.fn().mockReturnValue('Europe/Istanbul'),
}));

// Import app after mocks
const app = require('../app.js');

describe('GET /period_settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).get('/period_settings');
    expect(res.status).toBe(401);
  });

  it('returns list of period settings when authenticated', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute.mockResolvedValueOnce([[
      { id: 1, name: 'Yaz Dönemi', start_date: '2026-06-01', end_date: '2026-08-31', data_json: '{}' },
      { id: 2, name: 'Kış Dönemi', start_date: '2026-09-01', end_date: '2026-12-31', data_json: '{}' },
    ]]);

    const res = await request(app)
      .get('/period_settings')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body.items).toHaveLength(2);
  });

  it('returns empty list when no period settings exist', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get('/period_settings')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('POST /period_settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app)
      .post('/period_settings')
      .send({
        name: 'Test Period',
        start_date: '2026-06-01',
        end_date: '2026-08-31',
        data_json: {},
      });

    expect(res.status).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    const res = await request(app)
      .post('/period_settings')
      .set('Authorization', `Bearer ${token}`)
      .send({}); // missing all fields

    expect(res.status).toBe(400);
  });

  it('creates period setting successfully', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute.mockResolvedValueOnce([{ insertId: 1 }]);

    const res = await request(app)
      .post('/period_settings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Yaz Dönemi',
        start_date: '2026-06-01',
        end_date: '2026-08-31',
        data_json: {
          settings: { start_hour: '10:00', end_hour: '20:00', closed_days: [] },
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe(1);
  });

  it('returns 400 when start_date > end_date', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    const res = await request(app)
      .post('/period_settings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Test',
        start_date: '2026-12-31',
        end_date: '2026-01-01',
        data_json: { settings: {} },
      });

    expect(res.status).toBe(400);
  });
});

describe('POST /period_settings/:id/preview-update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app)
      .post('/period_settings/1/preview-update')
      .send({ data_json: { settings: { start_hour: '09:00' } } });

    expect(res.status).toBe(401);
  });

  it('returns 400 when data_json is missing', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    const res = await request(app)
      .post('/period_settings/1/preview-update')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 404 when period setting not found', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/period_settings/999/preview-update')
      .set('Authorization', `Bearer ${token}`)
      .send({ data_json: { settings: { start_hour: '09:00' } } });

    expect(res.status).toBe(404);
  });

  it('returns has_conflict=false when hours unchanged', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute.mockResolvedValueOnce([[{
      data_json: JSON.stringify({ settings: { start_hour: '09:00', end_hour: '22:00' } })
    }]]);

    const res = await request(app)
      .post('/period_settings/1/preview-update')
      .set('Authorization', `Bearer ${token}`)
      .send({
        data_json: { settings: { start_hour: '09:00', end_hour: '22:00' } },
      });

    expect(res.status).toBe(200);
    expect(res.body.has_conflict).toBe(false);
  });

  it('returns has_conflict=true when new hours exclude appointments', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute
      .mockResolvedValueOnce([[{
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        data_json: JSON.stringify({ settings: { start_hour: '09:00', end_hour: '22:00' } })
      }]])
      .mockResolvedValueOnce([[
        { id: 1, start_at: '2026-06-15 20:30:00', customer_name: 'Test' },
      ]]);

    const res = await request(app)
      .post('/period_settings/1/preview-update')
      .set('Authorization', `Bearer ${token}`)
      .send({
        data_json: { settings: { start_hour: '09:00', end_hour: '20:00' } },
      });

    expect(res.status).toBe(200);
    expect(res.body.has_conflict).toBe(true);
    expect(res.body.appointment_count).toBe(1);
  });
});

describe('POST /period_settings/:id (delete)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app)
      .post('/period_settings/1')
      .send({ _method: 'delete' });

    expect(res.status).toBe(401);
  });

  it('returns 404 when period setting not found', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/period_settings/999')
      .set('Authorization', `Bearer ${token}`)
      .send({ _method: 'delete' });

    expect(res.status).toBe(404);
  });

  it('deletes period setting successfully', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute
      .mockResolvedValueOnce([[{ start_date: '2026-06-01', end_date: '2026-06-30' }]]) // period found
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete result

    const res = await request(app)
      .post('/period_settings/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ _method: 'delete' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('cancels appointments when cancel_appointments=true', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute
      .mockResolvedValueOnce([[{ start_date: '2026-06-01', end_date: '2026-06-30' }]]) // period
      .mockResolvedValueOnce([[{ cnt: 5 }]]) // appointment count
      .mockResolvedValueOnce([{ affectedRows: 5 }]) // update result
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete result

    const res = await request(app)
      .post('/period_settings/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ _method: 'delete', cancel_appointments: true });

    expect(res.status).toBe(200);
    expect(res.body.affectedAppointments).toBe(5);
  });
});

describe('POST /period_settings/for-date', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app)
      .post('/period_settings/for-date')
      .send({ date: '2026-06-15' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when date is missing', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    const res = await request(app)
      .post('/period_settings/for-date')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid date format', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    const res = await request(app)
      .post('/period_settings/for-date')
      .set('Authorization', `Bearer ${token}`)
      .send({ date: 'invalid' });

    expect(res.status).toBe(400);
  });

  it('returns period settings for valid date', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      start_date: '2026-06-01',
      end_date: '2026-08-31',
      data_json: JSON.stringify({ settings: { start_hour: '10:00', end_hour: '20:00' } }),
    }]]);

    const res = await request(app)
      .post('/period_settings/for-date')
      .set('Authorization', `Bearer ${token}`)
      .send({ date: '2026-06-15' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 1);
  });

  it('returns empty object when no period settings for date', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Admin',
    }]]);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ phone: '5467473915', password: 'test123' });

    const token = loginRes.body?.token;

    mockPool.execute.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/period_settings/for-date')
      .set('Authorization', `Bearer ${token}`)
      .send({ date: '2026-06-15' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeNull();
  });
});