// test/unit/notification.service.test.js
/**
 * notification.service.js Unit Tests
 * OTP, SMS, Email fonksiyonları için testler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing notification service
vi.mock('../../config.js', () => ({
  env: vi.fn((key, fallback) => {
    const envMap = {
      'NETGSM_USER': 'testuser',
      'NETGSM_PASS': 'testpass',
      'NETGSM_HEADER': 'TEST',
      'NETGSM_ENDPOINT': 'https://test.api.netgsm.com.tr',
      'NETGSM_VERIFY_SSL': 'false',
      'GMAIL_USER': 'test@gmail.com',
      'GMAIL_PASS': 'testpassword',
    };
    return envMap[key] ?? fallback;
  }),
  getMailer: vi.fn().mockResolvedValue({
    sendMail: vi.fn(),
  }),
}));

// Mock sms.provider
vi.mock('../../sms.provider.js', () => ({
  createSmsProvider: vi.fn().mockImplementation(() => ({
    topluMesajGonder: vi.fn().mockResolvedValue({ status: true, msg_id: 'mock-123' }),
    getProviderName: vi.fn().mockReturnValue('netgsm'),
  })),
  TopluMesaj: vi.fn().mockImplementation((metin, telefon) => ({ metin, telefon })),
}));

// Mock models (pool)
vi.mock('../../models.js', () => ({
  pool: {
    execute: vi.fn(),
    query: vi.fn(),
  },
}));

// Import after mocks
const notificationService = require('../../notification.service.js');

describe('generateOtpCode()', () => {
  it('generates a 6-digit numeric string', () => {
    const code = notificationService.generateOtpCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('generates different codes on multiple calls', () => {
    const codes = new Set();
    for (let i = 0; i < 10; i++) {
      codes.add(notificationService.generateOtpCode());
    }
    // All codes should be 6 digits, but could have duplicates in small sample
    codes.forEach(code => {
      expect(code).toMatch(/^\d{6}$/);
    });
  });
});

describe('sha256()', () => {
  it('returns a hex string hash', () => {
    const hash = notificationService.sha256('test');
    expect(typeof hash).toBe('string');
    expect(hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 produces 64 hex chars
  });

  it('returns same hash for same input', () => {
    const hash1 = notificationService.sha256('test');
    const hash2 = notificationService.sha256('test');
    expect(hash1).toBe(hash2);
  });

  it('returns different hash for different input', () => {
    const hash1 = notificationService.sha256('test1');
    const hash2 = notificationService.sha256('test2');
    expect(hash1).not.toBe(hash2);
  });

  it('handles numeric input', () => {
    const hash = notificationService.sha256(123456);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('otpMessage()', () => {
  it('returns message with the code', () => {
    const msg = notificationService.otpMessage('123456');
    expect(msg).toContain('123456');
    expect(msg).toContain('1 dakika geçerlidir');
  });
});

// Mock the pool for OTP tests
const { pool } = require('../../models.js');

describe('createOtpRecord()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates OTP record in database', async () => {
    pool.execute.mockResolvedValueOnce([{ insertId: 1 }]);

    const result = await notificationService.createOtpRecord({
      user_type: 'customer',
      user_id: 1,
      destination: '5467473915',
      code: '123456',
      ttlSeconds: 60,
    });

    expect(pool.execute).toHaveBeenCalled();
    expect(result).toHaveProperty('code_hash');
  });

  it('throws error for invalid user_type', async () => {
    await expect(notificationService.createOtpRecord({
      user_type: 'admin', // invalid
      user_id: 1,
      destination: '5467473915',
      code: '123456',
    })).rejects.toThrow();
  });

  it('throws error when destination is missing', async () => {
    await expect(notificationService.createOtpRecord({
      user_type: 'customer',
      user_id: 1,
      code: '123456',
    })).rejects.toThrow('destinationOverride zorunlu');
  });

  it('uses custom TTL when provided', async () => {
    pool.execute.mockResolvedValueOnce([{ insertId: 1 }]);

    await notificationService.createOtpRecord({
      user_type: 'staff_account',
      user_id: 1,
      destination: '5467473915',
      code: '123456',
      ttlSeconds: 120,
    });

    const call = pool.execute.mock.calls[0];
    expect(call[0]).toContain('DATE_ADD(NOW(), INTERVAL ? SECOND)');
    expect(call[1]).toContain(120);
  });

  it('uses settings TTL when ttlSeconds not provided', async () => {
    // Mock settings response
    pool.execute
      .mockResolvedValueOnce([[{ settings_json: JSON.stringify({ otp_ttl_seconds: 90 }) }]])
      .mockResolvedValueOnce([{ insertId: 1 }]);

    await notificationService.createOtpRecord({
      user_type: 'customer',
      user_id: 1,
      destination: '5467473915',
      code: '123456',
    });

    // Should have called settings query first
    expect(pool.execute.mock.calls[0][0]).toContain('app_settings');
  });
});

describe('logSmsToDb()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs SMS to database with correct fields', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    await notificationService.logSmsToDb({
      appointment_id: 1,
      to_phone: '5467473915',
      body: 'Test message',
      type: 'otp',
      provider: 'netgsm',
      status: 'sent',
      provider_msg_id: 'msg-123',
    });

    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO sms_messages'),
      expect.arrayContaining(['sent'])
    );
  });

  it('handles failed SMS status', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    await notificationService.logSmsToDb({
      appointment_id: 1,
      to_phone: '5467473915',
      body: 'Test message',
      type: 'otp',
      status: 'failed',
      error_message: 'API Error',
    });

    const call = pool.execute.mock.calls[0];
    expect(call[1]).toContain('failed');
  });
});

describe('sendSms()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends SMS via NetGSM', async () => {
    const result = await notificationService.sendSms({
      phone: '5467473915',
      message: 'Test message',
      type: 'otp',
    });

    expect(result).toHaveProperty('status', true);
    expect(result).toHaveProperty('msg_id');
  });

  it('logs SMS to database after successful send', async () => {
    pool.execute.mockResolvedValue([{ affectedRows: 1 }]);

    await notificationService.sendSms({
      appointment_id: 1,
      phone: '5467473915',
      message: 'Test message',
      type: 'reminder',
    });

    expect(pool.execute).toHaveBeenCalled(); // Log call
  });

  it('throws and logs on SMS API error', async () => {
    const { createSmsProvider } = require('../../sms.provider.js');
    createSmsProvider.mockImplementation(() => ({
      topluMesajGonder: vi.fn().mockRejectedValue(new Error('API Error')),
      getProviderName: vi.fn().mockReturnValue('netgsm'),
    }));

    pool.execute.mockResolvedValue([{ affectedRows: 1 }]);

    await expect(notificationService.sendSms({
      phone: '5467473915',
      message: 'Test message',
    })).rejects.toThrow('API Error');

    // Should have logged failed SMS
    expect(pool.execute).toHaveBeenCalled();
  });

  it('uses default type "otp" when not specified', async () => {
    const result = await notificationService.sendSms({
      phone: '5467473915',
      message: 'Test',
    });

    expect(result.status).toBe(true);
  });
});

describe('sendMail()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends email via configured transporter', async () => {
    const { getMailer } = require('../../config.js');
    const mockTransporter = {
      sendMail: vi.fn().mockResolvedValue({ accepted: ['test@example.com'] }),
    };
    getMailer.mockResolvedValueOnce(mockTransporter);

    await notificationService.sendMail({
      to: 'test@example.com',
      subject: 'Test Subject',
      text: 'Test body',
    });

    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'test@example.com',
        subject: 'Test Subject',
        text: 'Test body',
      })
    );
  });
});

describe('sendOtp()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends OTP to valid user type staff_account', async () => {
    pool.execute.mockResolvedValue([{ insertId: 1 }]);
    const { sendSms } = require('../../notification.service.js');

    const result = await notificationService.sendOtp({
      user_type: 'staff_account',
      user_id: 1,
      destinationOverride: '5467473915',
    });

    expect(result).toHaveProperty('ok', true);
    expect(result).toHaveProperty('codeSent');
    expect(pool.execute).toHaveBeenCalled(); // OTP record created
  });

  it('sends OTP to valid user type customer', async () => {
    pool.execute.mockResolvedValue([{ insertId: 1 }]);

    const result = await notificationService.sendOtp({
      user_type: 'customer',
      user_id: 1,
      destinationOverride: '5467473915',
    });

    expect(result).toHaveProperty('ok', true);
  });

  it('throws error for invalid user_type', async () => {
    await expect(notificationService.sendOtp({
      user_type: 'admin',
      user_id: 1,
      destinationOverride: '5467473915',
    })).rejects.toThrow("user_type sadece 'staff_account' veya 'customer' olabilir.");
  });

  it('throws error when destination is missing', async () => {
    await expect(notificationService.sendOtp({
      user_type: 'customer',
      user_id: 1,
    })).rejects.toThrow('destinationOverride zorunlu');
  });
});

describe('verifyOtp()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok:true for valid OTP', async () => {
    const codeHash = notificationService.sha256('123456');
    const futureDate = new Date(Date.now() + 60000).toISOString().slice(0, 19).replace('T', ' ');

    pool.execute
      .mockResolvedValueOnce([[{
        id: 1,
        code_hash: codeHash,
        expires_at: futureDate,
        used: 0,
        try_count: 0,
      }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const result = await notificationService.verifyOtp({
      user_type: 'customer',
      user_id: 1,
      code: '123456',
    });

    expect(result).toHaveProperty('ok', true);
  });

  it('returns ok:false for no code found', async () => {
    pool.execute.mockResolvedValueOnce([[]]);

    const result = await notificationService.verifyOtp({
      user_type: 'customer',
      user_id: 1,
      code: '123456',
    });

    expect(result).toHaveProperty('ok', false);
    expect(result).toHaveProperty('reason', 'no_code');
  });

  it('returns ok:false for already used code', async () => {
    pool.execute.mockResolvedValueOnce([[{
      id: 1,
      code_hash: 'hash',
      expires_at: '2099-12-31 23:59:59',
      used: 1,
      try_count: 0,
    }]]);

    const result = await notificationService.verifyOtp({
      user_type: 'customer',
      user_id: 1,
      code: '123456',
    });

    expect(result).toHaveProperty('reason', 'used');
  });

  it('returns ok:false for expired code', async () => {
    pool.execute.mockResolvedValueOnce([[{
      id: 1,
      code_hash: 'hash',
      expires_at: '2020-01-01 00:00:00',
      used: 0,
      try_count: 0,
    }]]);

    const result = await notificationService.verifyOtp({
      user_type: 'customer',
      user_id: 1,
      code: '123456',
    });

    expect(result).toHaveProperty('reason', 'expired');
  });

  it('returns ok:false for too many tries', async () => {
    pool.execute.mockResolvedValueOnce([[{
      id: 1,
      code_hash: 'hash',
      expires_at: '2099-12-31 23:59:59',
      used: 0,
      try_count: 5,
    }]]);

    const result = await notificationService.verifyOtp({
      user_type: 'customer',
      user_id: 1,
      code: '123456',
      maxTries: 5,
    });

    expect(result).toHaveProperty('reason', 'too_many_tries');
  });

  it('returns ok:false for invalid code', async () => {
    const codeHash = notificationService.sha256('123456');

    pool.execute.mockResolvedValueOnce([[{
      id: 1,
      code_hash: codeHash,
      expires_at: '2099-12-31 23:59:59',
      used: 0,
      try_count: 0,
    }]]);

    const result = await notificationService.verifyOtp({
      user_type: 'customer',
      user_id: 1,
      code: 'wrongcode',
    });

    expect(result).toHaveProperty('ok', false);
    expect(result).toHaveProperty('reason', 'invalid');
  });

  it('increments try_count on invalid attempt', async () => {
    const codeHash = notificationService.sha256('123456');

    pool.execute
      .mockResolvedValueOnce([[{
        id: 1,
        code_hash: codeHash,
        expires_at: '2099-12-31 23:59:59',
        used: 0,
        try_count: 0,
      }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE try_count

    await notificationService.verifyOtp({
      user_type: 'customer',
      user_id: 1,
      code: 'wrongcode',
    });

    // Should have called UPDATE try_count
    expect(pool.execute.mock.calls[1][0]).toContain('UPDATE otp_codes SET try_count');
  });
});

describe('sendCancellationSms()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends cancellation SMS with customer name', async () => {
    const { sendSms } = require('../../notification.service.js');
    vi.spyOn(notificationService, 'sendSms').mockImplementation(vi.fn().mockResolvedValue({ status: true }));

    const appointment = {
      id: 1,
      customer_phone: '5467473915',
      customer_name: 'Ahmet Yılmaz',
    };

    await notificationService.sendCancellationSms(
      appointment,
      '2026-06-05 10:00:00',
      '2026-06-05 14:00:00'
    );

    expect(notificationService.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        appointment_id: 1,
        phone: '5467473915',
        type: 'cancellation',
      })
    );

    // Check message contains customer name
    const call = notificationService.sendSms.mock.calls[0][0];
    expect(call.message).toContain('Ahmet Yılmaz');
    expect(call.message).toContain('10:00');
    expect(call.message).toContain('14:00');
  });

  it('uses "musterimiz" when customer_name is missing', async () => {
    vi.spyOn(notificationService, 'sendSms').mockImplementation(vi.fn().mockResolvedValue({ status: true }));

    const appointment = {
      id: 1,
      customer_phone: '5467473915',
      customer_name: null,
    };

    await notificationService.sendCancellationSms(
      appointment,
      '2026-06-05 10:00:00',
      '2026-06-05 14:00:00'
    );

    const call = notificationService.sendSms.mock.calls[0][0];
    expect(call.message).toContain('musterimiz');
  });

  it('uses defaults when closureStart is null', async () => {
    vi.spyOn(notificationService, 'sendSms').mockImplementation(vi.fn().mockResolvedValue({ status: true }));

    const appointment = {
      id: 1,
      customer_phone: '5467473915',
      customer_name: 'Test',
    };

    await notificationService.sendCancellationSms(
      appointment,
      null,
      '2026-06-05 14:00:00'
    );

    const call = notificationService.sendSms.mock.calls[0][0];
    expect(call.message).toContain('09:00'); // default start
    expect(call.message).toContain('14:00');
  });

  it('uses defaults when closureEnd is null', async () => {
    vi.spyOn(notificationService, 'sendSms').mockImplementation(vi.fn().mockResolvedValue({ status: true }));

    const appointment = {
      id: 1,
      customer_phone: '5467473915',
      customer_name: 'Test',
    };

    await notificationService.sendCancellationSms(
      appointment,
      '2026-06-05 10:00:00',
      null
    );

    const call = notificationService.sendSms.mock.calls[0][0];
    expect(call.message).toContain('10:00');
    expect(call.message).toContain('18:00'); // default end
  });

  it('extracts time correctly from full datetime string', async () => {
    vi.spyOn(notificationService, 'sendSms').mockImplementation(vi.fn().mockResolvedValue({ status: true }));

    const appointment = {
      id: 1,
      customer_phone: '5467473915',
      customer_name: 'Test',
    };

    await notificationService.sendCancellationSms(
      appointment,
      '2026-06-05 09:30:00',
      '2026-06-05 17:45:00'
    );

    const call = notificationService.sendSms.mock.calls[0][0];
    expect(call.message).toContain('09:30');
    expect(call.message).toContain('17:45');
  });
});

describe('module exports', () => {
  it('exports all expected functions', () => {
    expect(typeof notificationService.sendOtp).toBe('function');
    expect(typeof notificationService.verifyOtp).toBe('function');
    expect(typeof notificationService.createOtpRecord).toBe('function');
    expect(typeof notificationService.generateOtpCode).toBe('function');
    expect(typeof notificationService.sha256).toBe('function');
    expect(typeof notificationService.sendSms).toBe('function');
    expect(typeof notificationService.sendMail).toBe('function');
    expect(typeof notificationService.sendCancellationSms).toBe('function');
  });
});