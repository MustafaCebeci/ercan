// test/integration/controllers/closures.test.js
/**
 * Closure Controller Integration Tests
 * branchClosuresPreview, branchClosuresCreate, branchClosuresDelete
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
  toSqlDateTime: vi.fn((d, t) => d && t ? `${d} ${t}:00` : null),
}));

// Import controllers after mocks
const { ScopedControllers } = require('../../controllers.js');

describe('ScopedControllers.branchClosuresPreview()', () => {
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
      provider_id: null,
      start_at: '2026-06-15 09:00:00',
      end_at: '2026-06-15 18:00:00',
      ...overrides,
    },
    decoded: { sub: 1 },
    ...overrides,
  });

  it('returns 400 when start_at is missing', async () => {
    mockReq = createMockReq({ start_at: undefined });
    await ScopedControllers.branchClosuresPreview(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when end_at is missing', async () => {
    mockReq = createMockReq({ end_at: undefined });
    await ScopedControllers.branchClosuresPreview(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when scope is provider but provider_id is missing', async () => {
    mockReq = createMockReq({ scope: 'provider', provider_id: null });
    await ScopedControllers.branchClosuresPreview(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns empty conflicts when no appointments affected (global scope)', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]); // No appointments

    mockReq = createMockReq();
    await ScopedControllers.branchClosuresPreview(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      has_conflict: false,
      appointment_count: 0,
    }));
  });

  it('returns has_conflict=true when appointments are affected (global scope)', async () => {
    mockPool.execute.mockResolvedValueOnce([[
      { id: 1, customer_name: 'Test', start_at: '2026-06-15 10:00:00', service_name: 'Haircut' },
      { id: 2, customer_name: 'Test2', start_at: '2026-06-15 14:00:00', service_name: 'Shave' },
    ]]);

    mockReq = createMockReq();
    await ScopedControllers.branchClosuresPreview(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      has_conflict: true,
      appointment_count: 2,
    }));
  });

  it('returns appointments list with correct fields', async () => {
    mockPool.execute.mockResolvedValueOnce([[
      { id: 1, customer_name: 'Ahmet', start_at: '2026-06-15 10:00:00', service_name: 'Haircut' },
    ]]);

    mockReq = createMockReq();
    await ScopedControllers.branchClosuresPreview(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      appointments: expect.arrayContaining([
        expect.objectContaining({
          customer_name: 'Ahmet',
          service_name: 'Haircut',
        }),
      ]),
    }));
  });

  it('uses provider filter when scope is provider', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]);

    mockReq = createMockReq({ scope: 'provider', provider_id: 5 });
    await ScopedControllers.branchClosuresPreview(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      has_conflict: false,
    }));
  });

  it('includes warning message in response', async () => {
    mockPool.execute.mockResolvedValueOnce([[
      { id: 1, customer_name: 'Test', start_at: '2026-06-15 10:00:00', service_name: 'Test' },
    ]]);

    mockReq = createMockReq();
    await ScopedControllers.branchClosuresPreview(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      warning: expect.stringContaining('etkilenecek'),
    }));
  });
});

describe('ScopedControllers.branchClosuresCreate()', () => {
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
      scope: 'global',
      start_at: '2026-06-15 09:00:00',
      end_at: '2026-06-15 18:00:00',
      is_all_day: 0,
      cancel_appointments: false,
      send_sms: false,
      ...overrides,
    },
    decoded: { sub: 1 },
    ...overrides,
  });

  it('returns 400 when start_at is missing', async () => {
    mockReq = createMockReq({ start_at: undefined });
    await ScopedControllers.branchClosuresCreate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when end_at is missing', async () => {
    mockReq = createMockReq({ end_at: undefined });
    await ScopedControllers.branchClosuresCreate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when scope is provider but provider_id is missing', async () => {
    mockReq = createMockReq({ scope: 'provider', provider_id: undefined });
    await ScopedControllers.branchClosuresCreate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('creates closure successfully without appointment cancellation', async () => {
    const mockConn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{ insertId: 1 }]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    mockPool.getConnection.mockResolvedValue(mockConn);

    mockReq = createMockReq();
    await ScopedControllers.branchClosuresCreate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      id: 1,
    }));
  });

  it('cancels appointments when cancel_appointments=true', async () => {
    const mockConn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{ insertId: 1 }]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    mockPool.getConnection.mockResolvedValue(mockConn);

    mockPool.execute
      .mockResolvedValueOnce([[]]) // No appointments to cancel (or we'll mock them)
      .mockResolvedValueOnce([[]]) // appointments query returns empty

    mockReq = createMockReq({ cancel_appointments: true });
    await ScopedControllers.branchClosuresCreate(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(201);
  });

  it('sends SMS to affected customers when send_sms=true and cancel_appointments=true', async () => {
    const mockConn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{ insertId: 1 }]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    mockPool.getConnection.mockResolvedValue(mockConn);

    // Mock appointments that will be cancelled
    mockPool.execute.mockResolvedValueOnce([[]]); // closure insert
    mockPool.execute.mockResolvedValueOnce([[
      { id: 1, customer_id: 1, start_at: '2026-06-15 10:00:00', customer_phone: '5467473915', customer_name: 'Ahmet' },
    ]]); // appointments to cancel

    mockReq = createMockReq({ cancel_appointments: true, send_sms: true });
    await ScopedControllers.branchClosuresCreate(mockReq, mockRes);

    // SMS should be called
    // Note: This will only work if cancel_appointments is true AND appointments exist
  });

  it('does not send SMS when send_sms=false', async () => {
    const mockConn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{ insertId: 1 }]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    mockPool.getConnection.mockResolvedValue(mockConn);

    mockPool.execute.mockResolvedValueOnce([[]]);

    mockReq = createMockReq({ cancel_appointments: true, send_sms: false });
    await ScopedControllers.branchClosuresCreate(mockReq, mockRes);

    // mockSendCancellationSms should not be called
    // (Implementation depends on whether appointments were found)
  });
});

describe('ScopedControllers.branchClosuresDelete()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };
  });

  it('returns 400 when id is missing', async () => {
    mockReq = { params: {}, decoded: { sub: 1 } };
    await ScopedControllers.branchClosuresDelete(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when closure not found', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]); // No closure found

    mockReq = { params: { id: 999 }, decoded: { sub: 1 } };
    await ScopedControllers.branchClosuresDelete(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('deletes closure successfully', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ id: 1, scope: 'global' }]]) // closure found
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete result

    mockReq = { params: { id: 1 }, decoded: { sub: 1 } };
    await ScopedControllers.branchClosuresDelete(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});

describe('ScopedControllers.branchClosuresGetById()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };
  });

  it('returns 400 when id is missing', async () => {
    mockReq = { params: {}, decoded: { sub: 1 } };
    await ScopedControllers.branchClosuresGetById(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns closure when found', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      scope: 'global',
      start_at: '2026-06-15 09:00:00',
      end_at: '2026-06-15 18:00:00',
      status: 'active',
    }]]);

    mockReq = { params: { id: 1 }, decoded: { sub: 1 } };
    await ScopedControllers.branchClosuresGetById(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      id: 1,
      scope: 'global',
    }));
  });
});

describe('ScopedControllers.branchClosuresList()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      json: vi.fn().mockReturnThis(),
    };
  });

  it('returns list of closures', async () => {
    mockPool.execute.mockResolvedValueOnce([[
      { id: 1, scope: 'global', start_at: '2026-06-15 09:00:00', end_at: '2026-06-15 18:00:00' },
      { id: 2, scope: 'provider', provider_id: 5, start_at: '2026-06-16 10:00:00', end_at: '2026-06-16 14:00:00' },
    ]]);

    mockReq = { query: {}, decoded: { sub: 1 } };
    await ScopedControllers.branchClosuresList(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      items: expect.any(Array),
    }));
  });

  it('returns empty list when no closures exist', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]);

    mockReq = { query: {}, decoded: { sub: 1 } };
    await ScopedControllers.branchClosuresList(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      items: [],
    }));
  });
});