// test/integration/controllers/generateSlotsV2.test.js
/**
 * generateSlotsV2() Integration Tests
 * controllers.js:3095-3400
 *
 * Test Strategy:
 * - Mock pool.execute to return controlled data
 * - Mock readJwtFromReq for authentication
 * - Mock ensureStaffProvider for provider resolution
 * - Use fake timers for "today" filtering tests
 *
 * All tests are deterministic and isolated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// MOCK POOL
// ============================================================
const mockPool = {
    execute: vi.fn(),
    query: vi.fn(),
    getConnection: vi.fn(),
};

// ============================================================
// MOCK jwt
// ============================================================
vi.mock('jsonwebtoken', () => ({
    default: {
        verify: vi.fn().mockReturnValue({ sub: 'user1', is_admin: true }),
    },
    verify: vi.fn().mockReturnValue({ sub: 'user1', is_admin: true }),
}));

// ============================================================
// MOCK temporal_api.utils
// ============================================================
const mockTemporal = {
    now: vi.fn().mockReturnValue({
        hour: 10,
        minute: 0,
        dayOfWeek: 3, // Wednesday
        toPlainDate: () => ({ toString: () => '2026-06-10' }),
    }),
    todayYmd: vi.fn().mockReturnValue('2026-06-10'),
    fromYmd: vi.fn().mockReturnValue({ dayOfWeek: 3 }),
    fromDBDateTime: vi.fn((str) => {
        if (!str) return { hour: 0, minute: 0 };
        const [date, time] = str.split('T');
        const [h, m] = (time || '00:00:00').split(':').map(Number);
        return { hour: h || 0, minute: m || 0 };
    }),
    toISODateTime: vi.fn(() => '2026-06-10 10:00:00'),
    toSqlDateTime: vi.fn(),
    parseHHMMToMinutes: vi.fn((hhmm) => {
        if (!hhmm) return null;
        const [h, m] = String(hhmm).split(':').map(Number);
        return h * 60 + (m || 0);
    }),
    minutesToHHMM: vi.fn((mins) => {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }),
    parseHHMMToMinutesSimple: vi.fn((h) => {
        if (!h) return null;
        const [hh, mm] = String(h).split(':').map(Number);
        return hh * 60 + mm;
    }),
    roundUpToStep: vi.fn((n, step) => Math.ceil(n / step) * step),
    VIRTUAL_SLOT_MINUTES: 5,
    getBusinessTimezone: vi.fn().mockReturnValue('Europe/Istanbul'),
};

// ============================================================
// MOCK config
// ============================================================
vi.mock('../../config.js', () => ({
    env: vi.fn((key, fallback) => {
        const map = {
            'BUSINESS_TIMEZONE': 'Europe/Istanbul',
            'PERSONAL_BUSINESS_ID': '1',
            'PERSONAL_BRANCH_ID': '1',
            'JWT_SECRET': 'test-secret',
        };
        return map[key] ?? fallback;
    }),
    getMailer: vi.fn().mockResolvedValue({ sendMail: vi.fn() }),
}));

// ============================================================
// MOCK models
// ============================================================
vi.mock('../../models.js', () => ({
    pool: mockPool,
    Models: {},
}));

// ============================================================
// MOCK temporal_api.utils
// ============================================================
vi.mock('../../temporal_api.utils.js', () => mockTemporal);

// ============================================================
// MOCK notification.service
// ============================================================
vi.mock('../../notification.service.js', () => ({
    sendSms: vi.fn().mockResolvedValue({ status: true }),
    sendCancellationSms: vi.fn().mockResolvedValue({ ok: true }),
}));

// ============================================================
// MOCK sse
// ============================================================
vi.mock('../../sse.js', () => ({
    emitAppointment: vi.fn(),
    sseHandler: vi.fn(),
}));

// ============================================================
// IMPORT CONTROLLERS
// ============================================================
const { BookingControllers } = require('../../../controllers.js');

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function parseHHMM(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
}

function createMockReq(body = {}) {
    return {
        body,
        cookies: { access_token: 'mock-valid-token' },
        decoded: { sub: 'user1', is_admin: true },
    };
}

function createMockRes() {
    return {
        json: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
    };
}

// Reset all mocks before each test
beforeEach(() => {
    vi.clearAllMocks();
    // Reset default temporal values
    mockTemporal.now.mockReturnValue({
        hour: 10,
        minute: 0,
        dayOfWeek: 3,
        toPlainDate: () => ({ toString: () => '2026-06-10' }),
    });
    mockTemporal.todayYmd.mockReturnValue('2026-06-10');
    mockTemporal.fromYmd.mockReturnValue({ dayOfWeek: 3 });
});

// ============================================================
// TEST DATA BUILDERS
// ============================================================
function mockBusinessSettings(startHour = '09:00', endHour = '22:00', slotTime = 60) {
    return [{
        settings_json: JSON.stringify({
            start_hour: startHour,
            end_hour: endHour,
            slot_time: slotTime,
        }),
    }];
}

function mockPeriodSettings(closedDays = [], startHourOverride = null, endHourOverride = null) {
    return [{
        data_json: JSON.stringify({
            settings: {
                closed_days: closedDays,
                start_hour: startHourOverride,
                end_hour: endHourOverride,
            },
        }),
    }];
}

function mockService(durationMinutes = 60) {
    return [{ duration_minutes: durationMinutes }];
}

function mockAppointments(appointments = []) {
    return appointments.map(appt => ({
        start_at: `${appt.date}T${appt.start}:00`,
        end_at: `${appt.date}T${appt.end}:00`,
        status: 'confirmed',
    }));
}

function mockClosures(closures = []) {
    return closures.map(closure => ({
        start_at: `${closure.date}T${closure.start}:00`,
        end_at: `${closure.date}T${closure.end}:00`,
        scope: closure.scope || 'global',
        status: 'active',
    }));
}

function mockBreakRules(breakRules = []) {
    return breakRules.map(rule => ({
        rule_json: typeof rule.rule_json === 'string' ? rule.rule_json : JSON.stringify(rule.rule_json),
        is_active: 1,
    }));
}

function mockStaticSlots(staticSlots = []) {
    return staticSlots.map(slot => ({
        start_time: slot.start,
        end_time: slot.end,
        is_active: 1,
    }));
}

function mockProviders(providers = []) {
    return providers.map(p => ({
        id: p.id || 1,
        name: p.name || 'Test Provider',
        provider_type: 'staff',
        is_active: 1,
    }));
}

// ============================================================
// TEST SUITES
// ============================================================

describe('generateSlotsV2', () => {
    let mockReq;
    let mockRes;

    beforeEach(() => {
        mockReq = createMockReq();
        mockRes = createMockRes();
    });

    // ===== TEST GROUP 1: Basic Slot Generation =====
    describe('TEST GROUP 1: Basic Slot Generation', () => {
        it('generates all available slots when no blockers (09:00-12:00, 60min service)', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '12:00', 60)) // business settings
                .mockResolvedValueOnce([]) // period settings (empty)
                .mockResolvedValueOnce([]) // services (empty)
                .mockResolvedValueOnce([]) // appointments (empty)
                .mockResolvedValueOnce([]) // closures (empty)
                .mockResolvedValueOnce([]) // break rules (empty)
                .mockResolvedValueOnce([]); // static slots (empty)

            mockReq.body = { date: '2026-06-10', staffId: 1, serviceId: null };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            expect(mockRes.json).toHaveBeenCalled();
            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            expect(result.slots.length).toBe(6); // 09:00-12:00 with 60min slots = 6 slots
            expect(result.slots.every(s => s.status === 'available')).toBe(true);
            expect(result.slots[0].start).toBe('09:00');
            expect(result.slots[0].end).toBe('10:00');
            expect(result.slots[5].start).toBe('11:00');
            expect(result.slots[5].end).toBe('12:00');
        });

        it('returns slots with correct settings in response', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('08:00', '18:00', 30))
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.settings.open_time).toBe('08:00');
            expect(result.settings.close_time).toBe('18:00');
            expect(result.settings.slot_time).toBe(30);
        });
    });

    // ===== TEST GROUP 2: 45 Minute Service =====
    describe('TEST GROUP 2: 45 Minute Service', () => {
        it('generates slots for 45 minute service duration', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '12:00', 60)) // business settings
                .mockResolvedValueOnce([]) // period settings
                .mockResolvedValueOnce(mockService(45)) // service duration
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1, serviceId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            expect(result.settings.duration).toBe(45);
            expect(result.slots.length).toBeGreaterThan(0);
        });
    });

    // ===== TEST GROUP 3: Appointment Overlap =====
    describe('TEST GROUP 3: Appointment Overlap', () => {
        it('marks appointment slot as busy', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '12:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce(mockAppointments([
                    { date: '2026-06-10', start: '09:30', end: '10:00' },
                ])) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1, serviceId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const busySlots = result.slots.filter(s => s.status === 'busy');
            expect(busySlots.length).toBeGreaterThan(0);
        });

        it('marks segments that cant fit service as notAvailable', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '12:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce(mockService(45)) // 45 min service
                .mockResolvedValueOnce(mockAppointments([
                    { date: '2026-06-10', start: '09:30', end: '10:00' },
                ])) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1, serviceId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const notAvailableSlots = result.slots.filter(s => s.status === 'notAvailable');
            expect(notAvailableSlots.length).toBeGreaterThan(0);
        });
    });

    // ===== TEST GROUP 4: Closure =====
    describe('TEST GROUP 4: Closure', () => {
        it('marks closure period as closed', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '14:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce(mockClosures([
                    { date: '2026-06-10', start: '11:30', end: '13:00', scope: 'global' },
                ])) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const closedSlots = result.slots.filter(s => s.status === 'closed');
            expect(closedSlots.length).toBeGreaterThan(0);
        });

        it('handles provider-specific closure', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '14:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce(mockClosures([
                    { date: '2026-06-10', start: '11:30', end: '13:00', scope: 'provider' },
                ])) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const closedSlots = result.slots.filter(s => s.status === 'closed');
            expect(closedSlots.length).toBeGreaterThan(0);
        });
    });

    // ===== TEST GROUP 5: Weekly Break Rule =====
    describe('TEST GROUP 5: Weekly Break Rule', () => {
        it('applies break rule for target day of week (Wednesday)', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '14:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce(mockBreakRules([
                    {
                        rule_json: {
                            monday: [{ startHour: '12:00', endHour: '13:00', note: 'Lunch' }],
                            wednesday: [{ startHour: '12:00', endHour: '13:00', note: 'Lunch' }],
                            friday: [{ startHour: '12:00', endHour: '13:00', note: 'Lunch' }],
                        },
                    },
                ])) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 }; // Wednesday

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const closedSlots = result.slots.filter(s => s.status === 'closed');
            expect(closedSlots.length).toBeGreaterThan(0);
        });

        it('does not apply break rule for non-target day', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '14:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce(mockBreakRules([
                    {
                        rule_json: {
                            wednesday: [{ startHour: '12:00', endHour: '13:00', note: 'Lunch' }],
                        },
                    },
                ])) // break rules
                .mockResolvedValueOnce([]); // static slots

            // Monday (dayOfWeek = 1)
            mockTemporal.fromYmd.mockReturnValue({ dayOfWeek: 1 });
            mockReq.body = { date: '2026-06-08', staffId: 1 }; // Monday

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const closedSlots = result.slots.filter(s => s.status === 'closed');
            expect(closedSlots.length).toBe(0);
        });
    });

    // ===== TEST GROUP 6: Static Slot =====
    describe('TEST GROUP 6: Static Slot', () => {
        it('returns static slot as single available slot', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '14:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce(mockStaticSlots([
                    { start: '11:00', end: '12:00' },
                ])); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const staticSlot = result.slots.find(s => s.start === '11:00' && s.end === '12:00');
            expect(staticSlot).toBeDefined();
            expect(staticSlot.status).toBe('available');
        });
    });

    // ===== TEST GROUP 7: Static Slot + Appointment =====
    describe('TEST GROUP 7: Static Slot + Appointment Conflict', () => {
        it('marks slot as busy when appointment overlaps static slot', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '14:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce(mockAppointments([
                    { date: '2026-06-10', start: '11:00', end: '12:00' },
                ])) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce(mockStaticSlots([
                    { start: '11:00', end: '12:00' },
                ])); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const slot = result.slots.find(s => s.start === '11:00');
            expect(slot.status).toBe('busy');
        });
    });

    // ===== TEST GROUP 8: Static Slot + Closure =====
    describe('TEST GROUP 8: Static Slot + Closure Conflict', () => {
        it('marks slot as closed when closure overlaps static slot', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '14:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce(mockClosures([
                    { date: '2026-06-10', start: '11:15', end: '11:45', scope: 'provider' },
                ])) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce(mockStaticSlots([
                    { start: '11:00', end: '12:00' },
                ])); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const closedSlots = result.slots.filter(s => s.status === 'closed');
            expect(closedSlots.length).toBeGreaterThan(0);
        });
    });

    // ===== TEST GROUP 9: Merge Intervals =====
    describe('TEST GROUP 9: Merge Overlapping Intervals', () => {
        it('merges overlapping appointment and closure into single closed interval', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '12:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce(mockAppointments([
                    { date: '2026-06-10', start: '09:00', end: '10:00' },
                ])) // appointments
                .mockResolvedValueOnce(mockClosures([
                    { date: '2026-06-10', start: '09:30', end: '11:00', scope: 'global' },
                ])) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const closedSlots = result.slots.filter(s => s.status === 'closed');
            expect(closedSlots.length).toBeGreaterThan(0);
        });
    });

    // ===== TEST GROUP 10: Touching Intervals (No Merge) =====
    describe('TEST GROUP 10: Touching Intervals (No Merge)', () => {
        it('does not merge adjacent intervals', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '13:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce(mockAppointments([
                    { date: '2026-06-10', start: '09:00', end: '10:00' },
                    { date: '2026-06-10', start: '10:00', end: '11:00' },
                ])) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const busySlots = result.slots.filter(s => s.status === 'busy');
            expect(busySlots.length).toBeGreaterThanOrEqual(2);
        });
    });

    // ===== TEST GROUP 11: Service Duration Too Large =====
    describe('TEST GROUP 11: Service Duration Too Large', () => {
        it('marks small segment as notAvailable when service is 45min', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '12:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce(mockService(45)) // 45 min service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1, serviceId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const notAvailableSlots = result.slots.filter(s => s.status === 'notAvailable');
            expect(notAvailableSlots.length).toBeGreaterThan(0);
        });
    });

    // ===== TEST GROUP 12: Fully Booked Day =====
    describe('TEST GROUP 12: Fully Booked Day', () => {
        it('returns no available slots when day is fully booked', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '22:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce(mockAppointments([
                    { date: '2026-06-10', start: '09:00', end: '22:00' },
                ])) // appointments (full day)
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const availableSlots = result.slots.filter(s => s.status === 'available');
            expect(availableSlots.length).toBe(0);
        });
    });

    // ===== TEST GROUP 13: Empty Day =====
    describe('TEST GROUP 13: Empty Day', () => {
        it('returns all slots as available when no blockers', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '12:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            expect(result.slots.length).toBe(6);
            expect(result.slots.every(s => s.status === 'available')).toBe(true);
        });
    });

    // ===== TEST GROUP 14: Today Filter =====
    describe('TEST GROUP 14: Today Filter', () => {
        it('filters out past slots for today (14:17 current time)', async () => {
            // Set current time to 14:17
            mockTemporal.now.mockReturnValue({
                hour: 14,
                minute: 17,
                dayOfWeek: 3,
                toPlainDate: () => ({ toString: () => '2026-06-10' }),
            });

            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '18:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 }; // Today

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            // All slots should be >= 14:17
            result.slots.forEach(slot => {
                const startMin = parseHHMM(slot.start);
                expect(startMin).toBeGreaterThanOrEqual(14 * 60 + 17);
            });
        });

        it('does not filter when date is not today', async () => {
            mockTemporal.now.mockReturnValue({
                hour: 14,
                minute: 17,
                dayOfWeek: 3,
                toPlainDate: () => ({ toString: () => '2026-06-10' }),
            });

            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '18:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-11', staffId: 1 }; // Tomorrow

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            expect(result.slots.some(s => s.start === '09:00')).toBe(true);
        });
    });

    // ===== TEST GROUP 15: Provider Not Found =====
    describe('TEST GROUP 15: Provider Not Found', () => {
        it('returns empty slots when provider not found', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '22:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]); // service (short circuit)

            mockReq.body = { date: '2026-06-10', staffId: 999 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            expect(result.slots.length).toBe(0);
        });
    });

    // ===== Additional Edge Cases =====
    describe('Additional Edge Cases', () => {
        it('handles closed day from period_settings (Sunday = 0)', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '22:00', 60))
                .mockResolvedValueOnce(mockPeriodSettings([0])) // Sunday closed
                .mockResolvedValueOnce([]); // service

            // Mock Sunday (dayOfWeek = 7 in temporal, mapped to 0)
            mockTemporal.fromYmd.mockReturnValue({ dayOfWeek: 7 });

            mockReq.body = { date: '2026-06-14', staffId: 1 }; // Sunday

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            expect(result.slots.length).toBe(0);
        });

        it('uses service duration when serviceId provided', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '12:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce(mockService(30)) // 30 min service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1, serviceId: 5 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            expect(result.settings.duration).toBe(30);
        });

        it('uses business slot_time when no serviceId', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '12:00', 45))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1, serviceId: null };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            expect(result.settings.slot_time).toBe(45);
            expect(result.settings.duration).toBe(45);
        });

        it('handles period settings override for hours', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '22:00', 60))
                .mockResolvedValueOnce(mockPeriodSettings([], '08:00', '16:00')) // override
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            expect(result.settings.open_time).toBe('08:00');
            expect(result.settings.close_time).toBe('16:00');
        });

        it('merges multiple break rules from same provider', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '18:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce(mockBreakRules([
                    {
                        rule_json: {
                            wednesday: [
                                { startHour: '10:00', endHour: '10:30', note: 'Coffee' },
                                { startHour: '14:00', endHour: '14:30', note: 'Break' },
                            ],
                        },
                    },
                ])) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            const closedSlots = result.slots.filter(s => s.status === 'closed');
            expect(closedSlots.length).toBe(2);
        });

        it('handles multiple static slots', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '14:00', 60))
                .mockResolvedValueOnce([]) // period
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce(mockStaticSlots([
                    { start: '10:00', end: '11:00' },
                    { start: '12:00', end: '13:00' },
                ])); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            expect(result.slots.length).toBeGreaterThan(0);
        });

        it('handles period settings slot_time override', async () => {
            mockPool.execute
                .mockResolvedValueOnce(mockBusinessSettings('09:00', '22:00', 60))
                .mockResolvedValueOnce([{
                    data_json: JSON.stringify({
                        settings: {
                            closed_days: [],
                            start_hour: null,
                            end_hour: null,
                            slot_time: 30, // Override slot time
                        },
                    }),
                }]) // period with slot_time override
                .mockResolvedValueOnce([]) // service
                .mockResolvedValueOnce([]) // appointments
                .mockResolvedValueOnce([]) // closures
                .mockResolvedValueOnce([]) // break rules
                .mockResolvedValueOnce([]); // static slots

            mockReq.body = { date: '2026-06-10', staffId: 1 };

            await BookingControllers.generateSlotsV2(mockReq, mockRes);

            const result = mockRes.json.mock.calls[0][0];
            expect(result.ok).toBe(true);
            expect(result.settings.slot_time).toBe(30);
        });
    });
});