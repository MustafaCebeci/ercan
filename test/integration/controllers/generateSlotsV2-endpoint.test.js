/**
 * generateSlotsV2 — Endpoint İş Mantığı Testleri (JWT/Http YOK)
 *
 * Bu test dosyası, controllers.js içindeki `generateSlotsV2` endpoint'inin
 * **iş mantığını** birebir taklit eder. JWT auth middleware'i, asyncWrap
 * error handler'ı, req/res objeleri yok.
 *
 * Test stratejisi:
 *   1) mockData objesine businessSettings, periodSettings, appointments,
 *      closures, service set et
 *   2) Temporal.now mock'la → farklı "şu an" senaryoları
 *   3) Controller'ın çağırdığı fonksiyonları (engine + booking-candidate-generator)
 *      doğrudan çalıştır — controller'a hiç bağlanma
 *   4) Engine + BookingCandidate çıktısını kontrol et
 *
 * Bug fix coverage: bugün için "müsait slot yok" senaryoları
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// HOISTED MOCKS — vi.mock factory'leri hoist edilir, referanslar
// vi.hoisted ile oluşturulmalı.
// ============================================================
const hoisted = vi.hoisted(() => {
    const temporal = {
        now: vi.fn(),
        todayYmd: vi.fn(),
        fromYmd: vi.fn(),
        fromDBDateTime: vi.fn(),
        toISODateTime: vi.fn(),
        toSqlDateTime: vi.fn(),
        parseHHMMToMinutes: vi.fn(),
        minutesToHHMM: vi.fn(),
        getBusinessTimezone: vi.fn(),
    };
    return {
        mockTemporal: temporal,
        mockData: {},
    };
});

const { mockTemporal, mockData } = hoisted;

// ============================================================
// MOCK POOL — gerekli değil ama require edilmesin diye minimal
// ============================================================
const mockPool = { execute: vi.fn() };

vi.mock('../../models.js', () => ({
    pool: mockPool,
    Models: {},
}));

vi.mock('../../notification.service.js', () => ({
    sendSms: vi.fn().mockResolvedValue({ status: true }),
    sendCancellationSms: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../sse.js', () => ({
    emitAppointment: vi.fn(),
    sseHandler: vi.fn(),
}));

// ============================================================
// MOCK temporal_api.utils
// ============================================================
mockTemporal.now.mockImplementation(() => ({
    hour: 10,
    minute: 0,
    dayOfWeek: 3,
    toPlainDate: () => ({ toString: () => '2026-06-10' }),
}));
mockTemporal.todayYmd.mockImplementation(() => '2026-06-10');
mockTemporal.fromYmd.mockImplementation(() => ({ dayOfWeek: 3 }));
mockTemporal.fromDBDateTime.mockImplementation((str) => {
    if (!str) return { hour: 0, minute: 0 };
    const normalized = String(str).replace(' ', 'T');
    const timePart = normalized.split('T')[1] || '00:00:00';
    const [h, m] = timePart.split(':').map(Number);
    return { hour: h || 0, minute: m || 0 };
});
mockTemporal.toISODateTime.mockImplementation(() => '2026-06-10 10:00:00');
mockTemporal.toSqlDateTime.mockImplementation((d, t) => `${d} ${t}:00`);
mockTemporal.parseHHMMToMinutes.mockImplementation((hhmm) => {
    if (!hhmm) return null;
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
});
mockTemporal.minutesToHHMM.mockImplementation((mins) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
});
mockTemporal.getBusinessTimezone.mockImplementation(() => 'Europe/Istanbul');

vi.mock('../../temporal_api.utils.js', () => mockTemporal);

// ============================================================
// IMPORT — GERÇEK MOTOR KODLARI (mock'lanmaz)
// ============================================================
const { generateSlotsV2Engine } = await import('../../../src/services/slot-generator-v2.js');
const { generateBookableSlots } = await import('../../../src/services/booking-candidate-generator.js');

// ============================================================
// HELPERS
// ============================================================
function setNow(hour, minute) {
    mockTemporal.now.mockReturnValue({
        hour,
        minute,
        dayOfWeek: 3,
        toPlainDate: () => ({ toString: () => '2026-06-10' }),
    });
}

function mockClosures(closures = []) {
    return closures.map(c => ({
        start_at: `${c.date}T${c.start}:00`,
        end_at: `${c.date}T${c.end}:00`,
        scope: c.scope || 'global',
        status: 'active',
    }));
}

// ============================================================
// ENDPOINT TAKLİDİ — controller'ın iş mantığını birebir taklit eder
// ============================================================
async function generateSlotsV2EndpointLogic({ date = '2026-06-10', serviceId = null } = {}) {
    const targetDate = date;
    const settingsJson = mockData.businessSettings || {};

    let startHour = String(settingsJson.start_hour ?? settingsJson.open_time ?? '09:00');
    let endHour = String(settingsJson.end_hour ?? settingsJson.close_time ?? '22:00');
    let slotTime = Number(settingsJson.slot_time ?? 60);

    // Period override
    if (mockData.periodSettings) {
        const ps = mockData.periodSettings;
        if (ps.start_hour) startHour = String(ps.start_hour);
        if (ps.end_hour) endHour = String(ps.end_hour);
        if (ps.slot_time) slotTime = Number(ps.slot_time);
    }

    // Service duration
    let duration = slotTime;
    if (serviceId && mockData.service?.duration_minutes) {
        duration = Number(mockData.service.duration_minutes);
    }

    // Appointments
    const appointments = (mockData.appointments || []).map(a => {
        const startDt = mockTemporal.fromDBDateTime(a.start_at);
        const endDt = mockTemporal.fromDBDateTime(a.end_at);
        return {
            start: `${String(startDt.hour).padStart(2, '0')}:${String(startDt.minute).padStart(2, '0')}`,
            end: `${String(endDt.hour).padStart(2, '0')}:${String(endDt.minute).padStart(2, '0')}`,
        };
    });

    // Closures
    const closures = (mockData.closures || []).map(c => {
        const startDt = mockTemporal.fromDBDateTime(c.start_at);
        const endDt = mockTemporal.fromDBDateTime(c.end_at);
        return {
            start: `${String(startDt.hour).padStart(2, '0')}:${String(startDt.minute).padStart(2, '0')}`,
            end: `${String(endDt.hour).padStart(2, '0')}:${String(endDt.minute).padStart(2, '0')}`,
            scope: c.scope,
            is_all_day: 0,
        };
    });

    const staticSlots = [];

    // Today filter
    const nowZ = mockTemporal.now();
    const isToday = targetDate === nowZ.toPlainDate().toString();
    const currentMinute = isToday ? nowZ.hour * 60 + nowZ.minute : null;

    // Engine
    const engineResult = generateSlotsV2Engine({
        date: targetDate,
        serviceDuration: duration,
        workingHours: { start: startHour, end: endHour },
        appointments,
        closures,
        breakRules: [],
        staticSlots,
        reservedSlots: [],
        isToday,
        currentMinute,
        settings: { slotTime },
    });

    // Eğer gün bitti (dayAlreadyOver) veya tüm gün kapalı (dayFullyClosed),
    // candidate generator'ı ATLA — çünkü default olarak tüm working hours'u
    // "available" yapıyor (boş timeline'da). Bu, bug fix sonrası doğru
    // boş/closed sinyallerini override ederdi.
    let bookableSlots;
    if (engineResult.dayAlreadyOver) {
        bookableSlots = [];
    } else if (engineResult.dayFullyClosed) {
        bookableSlots = engineResult.slots; // closed slot'ları olduğu gibi geçir
    } else {
        bookableSlots = generateBookableSlots({
            timeline: engineResult.slots,
            serviceDuration: duration,
            workingHours: { start: startHour, end: endHour },
            staticSlots,
            currentMinute: isToday ? currentMinute : null,
        });
    }

    return {
        ok: true,
        date: targetDate,
        slots: bookableSlots,
        settings: engineResult.settings,
        meta: {
            dayAlreadyOver: engineResult.dayAlreadyOver,
            dayFullyClosed: engineResult.dayFullyClosed,
            isToday,
        },
    };
}

// ============================================================
// Reset
// ============================================================
beforeEach(() => {
    setNow(10, 0);
    // mockData reset (mutation üzerinden)
    for (const k of Object.keys(mockData)) delete mockData[k];
});

function setupData({
    businessHours = ['09:00', '18:00'],
    slotTime = 60,
    serviceDuration = null,
    appointments = [],
    closures = [],
} = {}) {
    mockData.businessSettings = {
        start_hour: businessHours[0],
        end_hour: businessHours[1],
        slot_time: slotTime,
    };
    mockData.service = serviceDuration ? { duration_minutes: serviceDuration } : null;
    mockData.appointments = appointments;
    mockData.closures = mockClosures(closures);
}

// ============================================================
// TEST SUITES
// ============================================================
describe('generateSlotsV2 — Endpoint İş Mantığı (JWT/Http yok)', () => {

    // ========================================================
    // BUG FIX SENARYOLARI
    // ========================================================
    describe('Bug Fix Coverage — Bugün için müsait slot dönmeli', () => {

        it('Scenario A: 14:30 query → 14:00-15:00 inProgress, gelecek slotlar available', async () => {
            setNow(14, 30);
            setupData({ businessHours: ['09:00', '18:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            expect(result.ok).toBe(true);
            const inProgress = result.slots.filter(s => s.status === 'inProgress');
            expect(inProgress.some(s => s.start === '14:00')).toBe(true);
            const futureAvailable = result.slots.filter(
                s => s.status === 'available' && s.start >= '15:00'
            );
            expect(futureAvailable.length).toBeGreaterThan(0);
            expect(result.meta.dayAlreadyOver).toBe(false);
        });

        it('Scenario B: 21:30 query, close 22:00, 45dk service → 21:00-21:45 inProgress, dayAlreadyOver=false', async () => {
            setNow(21, 30);
            setupData({
                businessHours: ['09:00', '22:00'],
                slotTime: 60,
                serviceDuration: 45,
            });

            const result = await generateSlotsV2EndpointLogic({
                date: '2026-06-10', serviceId: 1,
            });

            expect(result.ok).toBe(true);
            // Yeni davranış: 21:30'da 21:00-21:45 fitting slot hâlâ devam ediyor → inProgress
            const inProgress = result.slots.filter(s => s.status === 'inProgress');
            expect(inProgress.some(s => s.start === '21:00')).toBe(true);
            // dayAlreadyOver=false çünkü gün henüz bitmedi (currentMinute < closeMin)
            expect(result.meta.dayAlreadyOver).toBe(false);
        });

        it('Scenario C: 23:00 query → empty + dayAlreadyOver', async () => {
            setNow(23, 0);
            setupData({ businessHours: ['09:00', '18:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            expect(result.ok).toBe(true);
            expect(result.slots.length).toBe(0);
            expect(result.meta.dayAlreadyOver).toBe(true);
        });

        it('Scenario D: 07:00 query → tüm slotlar available', async () => {
            setNow(7, 0);
            setupData({ businessHours: ['09:00', '18:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            expect(result.ok).toBe(true);
            expect(result.slots.length).toBeGreaterThan(0);
            expect(result.slots.every(s => s.status === 'available')).toBe(true);
            expect(result.meta.isToday).toBe(true);
            expect(result.meta.dayAlreadyOver).toBe(false);
        });

        it('Scenario E: 14:17 query → 14:00-15:00 inProgress, 09:00-14:00 atılır', async () => {
            setNow(14, 17);
            setupData({ businessHours: ['09:00', '18:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            const slot14 = result.slots.find(s => s.start === '14:00');
            expect(slot14).toBeDefined();
            expect(slot14.status).toBe('inProgress');

            const pastSlots = result.slots.filter(
                s => parseInt(s.start.split(':')[0]) < 14
            );
            expect(pastSlots.length).toBe(0);
        });

        it('Scenario F: yarın sorgusu → isToday=false', async () => {
            setNow(10, 0);
            setupData({ businessHours: ['09:00', '18:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-11' });

            expect(result.ok).toBe(true);
            expect(result.slots.length).toBeGreaterThan(0);
            expect(result.meta.isToday).toBe(false);
        });

        it('Scenario G: tüm gün closure + isToday → dayFullyClosed=true, hepsi closed', async () => {
            setNow(10, 0);
            setupData({
                businessHours: ['09:00', '18:00'],
                slotTime: 60,
                closures: [{ date: '2026-06-10', start: '00:00', end: '23:59' }],
            });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            expect(result.ok).toBe(true);
            expect(result.slots.length).toBeGreaterThan(0);
            expect(result.slots.every(s => s.status === 'closed')).toBe(true);
            expect(result.meta.dayFullyClosed).toBe(true);
            expect(result.meta.dayAlreadyOver).toBe(false);
        });

        it('Scenario H: currentMinute === slot.start → slot available (inProgress değil)', async () => {
            setNow(14, 0);
            setupData({ businessHours: ['14:00', '15:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            const slot14 = result.slots.find(s => s.start === '14:00');
            expect(slot14).toBeDefined();
            expect(slot14.status).toBe('available');
        });

        it('Scenario I: devam eden busy appointment → busy kalır', async () => {
            setNow(14, 20);
            setupData({
                businessHours: ['13:00', '17:00'],
                slotTime: 60,
                appointments: [{
                    start_at: '2026-06-10T14:00:00',
                    end_at: '2026-06-10T15:00:00',
                    status: 'confirmed',
                }],
            });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            const busy = result.slots.find(s => s.start === '14:00' && s.status === 'busy');
            expect(busy).toBeDefined();
        });

        it('Scenario J: response meta her zaman 3 boolean flag içerir', async () => {
            setNow(10, 0);
            setupData({ businessHours: ['09:00', '18:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            expect(result.ok).toBe(true);
            expect(result.meta).toEqual(
                expect.objectContaining({
                    dayAlreadyOver: expect.any(Boolean),
                    dayFullyClosed: expect.any(Boolean),
                    isToday: expect.any(Boolean),
                })
            );
        });

        it('Scenario K: 14:00 query → 14:00-15:00 available, 13:00-14:00 atılır', async () => {
            setNow(14, 0);
            setupData({ businessHours: ['09:00', '18:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            const slot14 = result.slots.find(s => s.start === '14:00');
            expect(slot14).toBeDefined();
            expect(slot14.status).toBe('available');
            const pastSlots = result.slots.filter(
                s => parseInt(s.start.split(':')[0]) < 14
            );
            expect(pastSlots.length).toBe(0);
        });

        it('Scenario L: 14:01 query → 14:00-15:00 inProgress', async () => {
            setNow(14, 1);
            setupData({ businessHours: ['09:00', '18:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            const slot14 = result.slots.find(s => s.start === '14:00');
            expect(slot14).toBeDefined();
            expect(slot14.status).toBe('inProgress');
        });

        it('Scenario M: 13:59 query → 14:00-15:00 available, 13:00-14:00 inProgress', async () => {
            setNow(13, 59);
            setupData({ businessHours: ['09:00', '18:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            const slot14 = result.slots.find(s => s.start === '14:00');
            const slot13 = result.slots.find(s => s.start === '13:00');
            // 14:00 henüz başlamamış (currentMinute 13:59 < 14:00) → available
            expect(slot14).toBeDefined();
            expect(slot14.status).toBe('available');
            // 13:00-14:00 devam ediyor (currentMinute 13:59 slot içinde) → inProgress
            expect(slot13).toBeDefined();
            expect(slot13.status).toBe('inProgress');
        });

        it('Scenario O: currentMinute 22:00 + close 22:00 → dayAlreadyOver=true', async () => {
            setNow(22, 0);
            setupData({ businessHours: ['09:00', '22:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            expect(result.ok).toBe(true);
            expect(result.slots.length).toBe(0);
            expect(result.meta.dayAlreadyOver).toBe(true);
        });

        it('Scenario P: currentMinute 21:59 + 60dk + close 22:00 → 21:00-22:00 inProgress', async () => {
            setNow(21, 59);
            setupData({ businessHours: ['09:00', '22:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            expect(result.ok).toBe(true);
            // Yeni davranış: 21:00-22:00 hâlâ devam ediyor → inProgress (gün bitmedi)
            const inProgress = result.slots.filter(s => s.status === 'inProgress');
            expect(inProgress.some(s => s.start === '21:00')).toBe(true);
            expect(result.meta.dayAlreadyOver).toBe(false);
        });
    });

    // ========================================================
    // REGRESSION — STANDART DAVRANIŞ
    // ========================================================
    describe('Regression — Standard slot generation', () => {

        it('returns available slots when no blockers', async () => {
            setNow(10, 0);
            setupData({ businessHours: ['09:00', '12:00'], slotTime: 60 });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            expect(result.ok).toBe(true);
            expect(result.slots.length).toBeGreaterThan(0);
            expect(result.slots.some(s => s.status === 'available' || s.status === 'inProgress')).toBe(true);
            expect(result.settings.open_time).toBe('09:00');
            expect(result.settings.close_time).toBe('12:00');
        });

        it('respects service duration when serviceId provided', async () => {
            setNow(10, 0);
            setupData({
                businessHours: ['09:00', '12:00'],
                slotTime: 60,
                serviceDuration: 45,
            });

            const result = await generateSlotsV2EndpointLogic({
                date: '2026-06-10', serviceId: 1,
            });

            expect(result.settings.duration).toBe(45);
        });

        it('handles appointments correctly (busy + available)', async () => {
            setNow(10, 0);
            setupData({
                businessHours: ['09:00', '15:00'],
                slotTime: 60,
                appointments: [{
                    start_at: '2026-06-10T10:00:00',
                    end_at: '2026-06-10T11:00:00',
                    status: 'confirmed',
                }],
            });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            const busy = result.slots.find(s => s.start === '10:00' && s.status === 'busy');
            expect(busy).toBeDefined();
        });

        it('handles closures correctly', async () => {
            setNow(10, 0);
            setupData({
                businessHours: ['09:00', '18:00'],
                slotTime: 60,
                closures: [{ date: '2026-06-10', start: '12:00', end: '13:00' }],
            });

            const result = await generateSlotsV2EndpointLogic({ date: '2026-06-10' });

            const closed = result.slots.find(s => s.start === '12:00' && s.status === 'closed');
            expect(closed).toBeDefined();
        });
    });
});
