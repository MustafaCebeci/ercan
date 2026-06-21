// test/integration/controllers/auth.test.js
/**
 * Auth Controller Integration Tests
 * login, verify, me, logout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock pool
const mockPool = {
  execute: vi.fn(),
  query: vi.fn(),
};

// Mock config
vi.mock('../../config.js', () => ({
  env: vi.fn((key, fallback) => {
    const map = {
      'JWT_SECRET': 'test-jwt-secret',
      'JWT_EXPIRES_IN': '1d',
      'BUSINESS_TIMEZONE': 'Europe/Istanbul',
      'PERSONAL_BUSINESS_ID': '1',
      'PERSONAL_BRANCH_ID': '1',
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
  sendOtp: vi.fn().mockResolvedValue({ ok: true, codeSent: '123456' }),
  verifyOtp: vi.fn().mockResolvedValue({ ok: true }),
  createOtpRecord: vi.fn().mockResolvedValue({ code_hash: 'hash' }),
}));

// Mock bcrypt
vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn().mockImplementation((password, hash) => {
      // Simple mock: password 'test123' matches hash 'test'
      return Promise.resolve(password === 'test123');
    }),
  },
}));

// Import controllers after mocks
const { AuthControllers } = require('../../controllers.js');

describe('AuthControllers.login()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      cookie: vi.fn().mockReturnThis(),
    };
  });

  const createMockReq = (overrides = {}) => ({
    body: {
      phone: '5467473915',
      password: 'test123',
      ...overrides,
    },
    ...overrides,
  });

  it('returns 400 when phone is missing', async () => {
    mockReq = createMockReq({ phone: undefined });
    await AuthControllers.login(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when password is missing', async () => {
    mockReq = createMockReq({ password: undefined });
    await AuthControllers.login(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 401 when customer not found', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]); // No customer found

    mockReq = createMockReq();
    await AuthControllers.login(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 when account is inactive', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      is_active: 0,
      password: 'hashed',
    }]]);

    mockReq = createMockReq();
    await AuthControllers.login(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('active'),
    }));
  });

  it('returns 200 with OTP when credentials are valid', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Test User',
    }]]);

    mockReq = createMockReq();
    await AuthControllers.login(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      method: 'otp',
    }));
  });

  it('sets JWT cookie on successful login', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      password: 'hashed',
      is_active: 1,
      display_name: 'Test User',
    }]]);

    mockReq = createMockReq();
    await AuthControllers.login(mockReq, mockRes);
    expect(mockRes.cookie).toHaveBeenCalled();
  });
});

describe('AuthControllers.verify()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      cookie: vi.fn().mockReturnThis(),
    };
  });

  const createMockReq = (overrides = {}) => ({
    body: {
      phone: '5467473915',
      code: '123456',
      ...overrides,
    },
    ...overrides,
  });

  it('returns 400 when phone is missing', async () => {
    mockReq = createMockReq({ phone: undefined });
    await AuthControllers.verify(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when code is missing', async () => {
    mockReq = createMockReq({ code: undefined });
    await AuthControllers.verify(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 401 when OTP is invalid', async () => {
    const { verifyOtp } = require('../../notification.service.js');
    verifyOtp.mockResolvedValueOnce({ ok: false, reason: 'invalid' });

    mockReq = createMockReq();
    await AuthControllers.verify(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when OTP is expired', async () => {
    const { verifyOtp } = require('../../notification.service.js');
    verifyOtp.mockResolvedValueOnce({ ok: false, reason: 'expired' });

    mockReq = createMockReq();
    await AuthControllers.verify(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining(' süresi doldu'),
    }));
  });

  it('returns 200 with token when OTP is valid', async () => {
    const { verifyOtp } = require('../../notification.service.js');
    verifyOtp.mockResolvedValueOnce({ ok: true });

    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      display_name: 'Test User',
    }]]);

    mockReq = createMockReq();
    await AuthControllers.verify(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      token: expect.any(String),
    }));
  });

  it('sets JWT cookie on successful verification', async () => {
    const { verifyOtp } = require('../../notification.service.js');
    verifyOtp.mockResolvedValueOnce({ ok: true });

    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      display_name: 'Test User',
    }]]);

    mockReq = createMockReq();
    await AuthControllers.verify(mockReq, mockRes);
    expect(mockRes.cookie).toHaveBeenCalledWith(
      expect.stringContaining('token'),
      expect.any(String),
      expect.any(Object)
    );
  });
});

describe('AuthControllers.me()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };
  });

  it('returns 401 when not authenticated', async () => {
    mockReq = { decoded: null };
    await AuthControllers.me(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it('returns customer info when authenticated', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      phone: '5467473915',
      display_name: 'Test User',
      email: 'test@example.com',
    }]]);

    mockReq = { decoded: { sub: 1, type: 'customer' } };
    await AuthControllers.me(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      id: 1,
      phone: '5467473915',
    }));
  });

  it('returns staff info when authenticated as staff', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      id: 1,
      name: 'Staff Member',
      phone: '5467473915',
    }]]);

    mockReq = { decoded: { sub: 1, type: 'staff_account' } };
    await AuthControllers.me(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      id: 1,
    }));
  });
});

describe('AuthControllers.logout()', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRes = {
      json: vi.fn().mockReturnThis(),
      clearCookie: vi.fn().mockReturnThis(),
    };
  });

  it('clears auth cookie and returns ok', async () => {
    mockReq = { decoded: { sub: 1 } };
    await AuthControllers.logout(mockReq, mockRes);
    expect(mockRes.clearCookie).toHaveBeenCalled();
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});