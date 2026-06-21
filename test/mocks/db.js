// test/mocks/db.js
// Mock database pool for unit and integration tests

import { vi } from 'vitest';

// Mock pool that can be configured per test
export function createMockPool(overrides = {}) {
  const mockExecute = vi.fn();
  const mockQuery = vi.fn();
  const mockGetConnection = vi.fn().mockResolvedValue({
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  });

  return {
    execute: mockExecute,
    query: mockQuery,
    getConnection: mockGetConnection,
    ...overrides,
  };
}

// Pre-configured mock pool for typical scenarios
export const mockPool = createMockPool();

// Helper to setup successful query results
export function mockQueryResult(mockFn, result) {
  mockFn.mockResolvedValueOnce([result]);
}

// Helper to setup error results
export function mockQueryError(mockFn, error) {
  mockFn.mockRejectedValueOnce(error);
}

// Mock transaction helper
export function mockTransaction(pool, commitResult = [], rollbackError = null) {
  const mockConn = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockImplementation(async (sql, params) => {
      // Simulate transaction work
      return [commitResult];
    }),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };

  pool.getConnection.mockResolvedValue(mockConn);
  return mockConn;
}

// Reset all mocks
export function resetMocks(pool) {
  pool.execute.mockReset();
  pool.query.mockReset();
  pool.getConnection.mockReset();
}

// Export default mock pool for convenience
export default mockPool;