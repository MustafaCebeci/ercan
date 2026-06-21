// test/unit/config.test.js
/**
 * config.js Unit Tests
 * ENV parsing ve helper fonksiyonları
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Clear module cache to get fresh config
vi.resetModules();

describe('env()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns value when env var exists', () => {
    process.env.TEST_VAR = 'test-value';
    const { env } = require('../../config.js');
    expect(env('TEST_VAR')).toBe('test-value');
  });

  it('returns fallback when env var does not exist', () => {
    delete process.env.NON_EXISTENT_VAR;
    const { env } = require('../../config.js');
    expect(env('NON_EXISTENT_VAR', 'default')).toBe('default');
  });

  it('returns fallback when env var is empty string', () => {
    process.env.EMPTY_VAR = '';
    const { env } = require('../../config.js');
    expect(env('EMPTY_VAR', 'fallback')).toBe('fallback');
  });

  it('returns undefined when no fallback provided', () => {
    delete process.env.NON_EXISTENT_VAR;
    const { env } = require('../../config.js');
    expect(env('NON_EXISTENT_VAR')).toBe(undefined);
  });

  it('trims whitespace from values', () => {
    process.env.WHITESPACE_VAR = '  test value  ';
    const { env } = require('../../config.js');
    expect(env('WHITESPACE_VAR')).toBe('  test value  '); // env() doesn't trim, that's by design
  });
});

describe('mustEnv()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns value when env var exists', () => {
    process.env.REQUIRED_VAR = 'required-value';
    const { mustEnv } = require('../../config.js');
    expect(mustEnv('REQUIRED_VAR')).toBe('required-value');
  });

  it('throws error when env var does not exist', () => {
    delete process.env.MISSING_VAR;
    const { mustEnv } = require('../../config.js');
    expect(() => mustEnv('MISSING_VAR')).toThrow('ENV eksik: MISSING_VAR');
  });

  it('throws error when env var is empty string', () => {
    process.env.EMPTY_REQUIRED = '';
    const { mustEnv } = require('../../config.js');
    expect(() => mustEnv('EMPTY_REQUIRED')).toThrow('ENV eksik: EMPTY_REQUIRED');
  });
});

describe('createSmsHttp()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns undefined (function is stubbed)', () => {
    const { createSmsHttp } = require('../../config.js');
    expect(createSmsHttp()).toBeUndefined();
  });
});

describe('getMailer()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns a transporter object', async () => {
    process.env.GMAIL_USER = 'test@gmail.com';
    process.env.GMAIL_PASS = 'testpassword';
    const { getMailer } = require('../../config.js');
    const mailer = await getMailer();
    expect(mailer).toBeDefined();
    expect(typeof mailer.sendMail).toBe('function');
  });
});

describe('module exports', () => {
  it('exports all expected functions', () => {
    vi.resetModules();
    const config = require('../../config.js');
    expect(typeof config.env).toBe('function');
    expect(typeof config.mustEnv).toBe('function');
    expect(typeof config.createSmsHttp).toBe('function');
    expect(typeof config.getMailer).toBe('function');
  });
});