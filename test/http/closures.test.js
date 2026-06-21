// test/http/closures.test.js
/**
 * HTTP Integration Tests - Closures endpoints
 * Tests /closures/* routes using supertest
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

describe('GET /closures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).get('/closures');
    expect(res.status).toBe(401);
  });

  it('returns list of closures when authenticated', async () => {
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
      { id: 1, scope: 'global', start_at: '2026-06-15 09:00:00', end_at: '2026-06-15 18:00:00' },
      { id: 2, scope: 'provider', provider_id: 5, start_at: '2026-06-16 10:00:00', end_at: '2026-06-16 14:00:00' },
    ]]);

    const res = await request(app)
      .get('/closures')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body.items).toHaveLength(2);
  });

  it('returns empty list when no closures exist', async () => {
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
      .get('/closures')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('POST /closures/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app)
      .post('/closures/preview')
      .send({ start_at: '2026-06-15 09:00:00', end_at: '2026-06-15 18:00:00' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when start_at is missing', async () => {
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
      .post('/closures/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ end_at: '2026-06-15 18:00:00' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when end_at is missing', async () => {
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
      .post('/closures/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ start_at: '2026-06-15 09:00:00' });

    expect(res.status).toBe(400);
  });

  it('returns has_conflict=false when no appointments affected', async () => {
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

    mockPool.execute.mockResolvedValueOnce([[]]); // no affected appointments

    const res = await request(app)
      .post('/closures/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({
        start_at: '2026-06-15 09:00:00',
        end_at: '2026-06-15 18:00:00',
      });

    expect(res.status).toBe(200);
    expect(res.body.has_conflict).toBe(false);
    expect(res.body.appointment_count).toBe(0);
  });

  it('returns has_conflict=true when appointments are affected', async () => {
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
      { id: 1, customer_name: 'Ahmet', start_at: '2026-06-15 10:00:00', service_name: 'Haircut' },
      { id: 2, customer_name: 'Mehmet', start_at: '2026-06-15 14:00:00', service_name: 'Shave' },
    ]]);

    const res = await request(app)
      .post('/closures/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({
        start_at: '2026-06-15 09:00:00',
        end_at: '2026-06-15 18:00:00',
      });

    expect(res.status).toBe(200);
    expect(res.body.has_conflict).toBe(true);
    expect(res.body.appointment_count).toBe(2);
  });
});

describe('POST /closures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app)
      .post('/closures')
      .send({ start_at: '2026-06-15 09:00:00', end_at: '2026-06-15 18:00:00' });

    expect(res.status).toBe(401);
  });

  it('creates closure successfully', async () => {
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

    const mockConn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{ insertId: 1 }]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    mockPool.getConnection.mockResolvedValue(mockConn);

    const res = await request(app)
      .post('/closures')
      .set('Authorization', `Bearer ${token}`)
      .send({
        scope: 'global',
        start_at: '2026-06-15 09:00:00',
        end_at: '2026-06-15 18:00:00',
        is_all_day: 0,
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it('returns 400 when start_at is missing', async () => {
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
      .post('/closures')
      .set('Authorization', `Bearer ${token}`)
      .send({ end_at: '2026-06-15 18:00:00' });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /closures/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).delete('/closures/1');
    expect(res.status).toBe(401);
  });

  it('returns 404 when closure not found', async () => {
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

    mockPool.execute.mockResolvedValueOnce([[]]); // no closure found

    const res = await request(app)
      .delete('/closures/999')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('deletes closure successfully', async () => {
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
      .mockResolvedValueOnce([[{ id: 1, scope: 'global' }]]) // closure found
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete result

    const res = await request(app)
      .delete('/closures/1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /closures/today', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns closures for today without auth (public endpoint)', async () => {
    mockPool.execute.mockResolvedValueOnce([[
      { id: 1, scope: 'global', start_at: '2026-06-08 09:00:00', end_at: '2026-06-08 18:00:00' },
    ]]);

    const res = await request(app).get('/closures/today');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
  });

  it('returns empty when no closures today', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]);

    const res = await request(app).get('/closures/today');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});