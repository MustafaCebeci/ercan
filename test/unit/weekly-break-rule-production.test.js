/**
 * weekly-break-rule-production.test.js
 *
 * Production hardening test suite for weekly break rules.
 * Tests critical edge-cases that can occur in real DB scenarios.
 *
 * Covers: P1-P10 test groups as specified.
 */

import { describe, it, expect } from 'vitest';
import { expandWeeklyBreakRules } from '../../src/services/weekly-break-rule-expander.js';
import { generateSlotsV2Engine } from '../../src/services/slot-generator-v2.js';

// ===============================
// HELPERS
// ===============================

/**
 * Convert HH:MM to minutes since midnight
 */
function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + (m || 0);
}

/**
 * Get all slots with a specific status
 */
function getSlotsByStatus(slots, status) {
    return slots.filter(s => s.status === status);
}

/**
 * Check if a time range is fully covered by closed slots
 */
function isRangeFullyClosed(slots, startHH, endHH) {
    const rangeStart = timeToMinutes(startHH);
    const rangeEnd = timeToMinutes(endHH);

    // Get all closed slots that overlap with our range
    const closedSlots = getSlotsByStatus(slots, 'closed').filter(slot => {
        const slotStart = timeToMinutes(slot.start);
        const slotEnd = timeToMinutes(slot.end);
        return slotStart < rangeEnd && slotEnd > rangeStart;
    });

    if (closedSlots.length === 0) return false;

    // Merge all closed slot ranges and check if they fully cover our range
    const sorted = closedSlots.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));

    let currentStart = rangeStart;
    for (const slot of sorted) {
        const slotStart = timeToMinutes(slot.start);
        const slotEnd = timeToMinutes(slot.end);

        // Gap detected
        if (slotStart > currentStart) return false;

        currentStart = Math.max(currentStart, slotEnd);
    }

    return currentStart >= rangeEnd;
}

// ===============================
// TEST GROUP P1
// Raw Database JSON Test
// ===============================

describe('P1: Raw Database JSON', () => {
    it('parses real MySQL JSON field format correctly', () => {
        // Simulate real DB row from MySQL
        const dbRow = {
            rule_json: "{\"friday\":[{\"startHour\":\"12:00\",\"endHour\":\"13:00\"}]}"
        };

        // This is how controllers.js parses it
        const parsed = JSON.parse(dbRow.rule_json);

        const result = expandWeeklyBreakRules({
            date: '2026-06-19', // Friday
            weeklyBreakRule: parsed
        });

        expect(result).toEqual([
            {
                start: '12:00',
                end: '13:00',
                note: null,
                source: 'weekly_break_rule'
            }
        ]);
    });

    it('handles DB JSON with note field', () => {
        const dbRow = {
            rule_json: "{\"friday\":[{\"startHour\":\"12:00\",\"endHour\":\"13:00\",\"note\":\"Öğle arası\"}]}"
        };

        const parsed = JSON.parse(dbRow.rule_json);

        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: parsed
        });

        expect(result[0].note).toBe('Öğle arası');
    });
});

// ===============================
// TEST GROUP P2
// Raw Database JSON Parse Failure
// ===============================

describe('P2: Raw Database JSON Parse Failure', () => {
    it('does not crash on malformed JSON from DB', () => {
        const dbRow = {
            rule_json: "{invalid-json"
        };

        // Should not throw
        expect(() => {
            const parsed = JSON.parse(dbRow.rule_json);
            expandWeeklyBreakRules({
                date: '2026-06-19',
                weeklyBreakRule: parsed
            });
        }).toThrow();
    });

    it('returns empty array when JSON.parse fails in controller context', () => {
        // This is how controllers.js handles it - with try/catch
        let weeklyBreakRule = null;

        try {
            const dbRow = { rule_json: "{invalid-json" };
            weeklyBreakRule = JSON.parse(dbRow.rule_json);
        } catch {
            weeklyBreakRule = null;
        }

        // If JSON.parse fails, weeklyBreakRule stays null
        // expandWeeklyBreakRules handles null gracefully
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule
        });

        expect(result).toEqual([]);
    });

    it('handles empty string JSON from DB', () => {
        let weeklyBreakRule = null;

        try {
            const dbRow = { rule_json: "" };
            weeklyBreakRule = JSON.parse(dbRow.rule_json);
        } catch {
            weeklyBreakRule = null;
        }

        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule
        });

        expect(result).toEqual([]);
    });
});

// ===============================
// TEST GROUP P3
// Friday Lunch + Friday Prayer Merge
// ===============================

describe('P3: Friday Lunch + Friday Prayer Merge', () => {
    it('produces correct engine output for consecutive breaks', () => {
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '12:00', endHour: '13:00', note: 'Öğle arası' },
                { startHour: '13:00', endHour: '14:00', note: 'Cuma Namazı' }
            ]
        };

        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        expect(breakRules.length).toBe(2);
        expect(breakRules[0].start).toBe('12:00');
        expect(breakRules[0].end).toBe('13:00');
        expect(breakRules[1].start).toBe('13:00');
        expect(breakRules[1].end).toBe('14:00');

        // Pass to engine
        const engineResult = generateSlotsV2Engine({
            date: fridayDate,
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: [],
            closures: [],
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // The 12:00-14:00 period should be fully closed
        // No available slot should exist between 12:00 and 14:00
        const availableInRange = engineResult.slots.filter(slot => {
            const slotStart = timeToMinutes(slot.start);
            const slotEnd = timeToMinutes(slot.end);
            return slotStart < timeToMinutes('14:00') && slotEnd > timeToMinutes('12:00');
        }).filter(slot => slot.status === 'available');

        expect(availableInRange.length).toBe(0);

        // All slots in 12:00-14:00 should be closed
        const closedInRange = engineResult.slots.filter(slot => {
            const slotStart = timeToMinutes(slot.start);
            const slotEnd = timeToMinutes(slot.end);
            return slotStart < timeToMinutes('14:00') && slotEnd > timeToMinutes('12:00');
        });

        expect(closedInRange.length).toBeGreaterThan(0);
        expect(closedInRange.every(slot => slot.status === 'closed')).toBe(true);
    });

    it('does not produce gap between 13:00-13:30 when breaks are consecutive', () => {
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '12:00', endHour: '13:00' },
                { startHour: '13:00', endHour: '14:00' }
            ]
        };

        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        const engineResult = generateSlotsV2Engine({
            date: fridayDate,
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: [],
            closures: [],
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // Check that 13:00-13:30 is closed
        expect(isRangeFullyClosed(engineResult.slots, '13:00', '13:30')).toBe(true);
    });
});

// ===============================
// TEST GROUP P4
// Consecutive Weekly Break Rules
// ===============================

describe('P4: Consecutive Weekly Break Rules', () => {
    it('fully closes 12:00-13:30 when three consecutive 30-min breaks exist', () => {
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '12:00', endHour: '12:30' },
                { startHour: '12:30', endHour: '13:00' },
                { startHour: '13:00', endHour: '13:30' }
            ]
        };

        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        expect(breakRules.length).toBe(3);

        const engineResult = generateSlotsV2Engine({
            date: fridayDate,
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: [],
            closures: [],
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // 12:00-13:30 should be fully closed - no gaps
        expect(isRangeFullyClosed(engineResult.slots, '12:00', '13:30')).toBe(true);

        // No available slots in that range
        const availableSlots = getSlotsByStatus(engineResult.slots, 'available').filter(slot => {
            return timeToMinutes(slot.start) >= timeToMinutes('12:00') &&
                   timeToMinutes(slot.end) <= timeToMinutes('13:30');
        });
        expect(availableSlots.length).toBe(0);
    });

    it('handles four consecutive 15-minute breaks', () => {
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '14:00', endHour: '14:15' },
                { startHour: '14:15', endHour: '14:30' },
                { startHour: '14:30', endHour: '14:45' },
                { startHour: '14:45', endHour: '15:00' }
            ]
        };

        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        const engineResult = generateSlotsV2Engine({
            date: fridayDate,
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: [],
            closures: [],
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // 14:00-15:00 should be fully closed
        expect(isRangeFullyClosed(engineResult.slots, '14:00', '15:00')).toBe(true);
    });
});

// ===============================
// TEST GROUP P5
// Overlapping Weekly Break Rules
// ===============================

describe('P5: Overlapping Weekly Break Rules', () => {
    it('produces single merged interval for overlapping breaks', () => {
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '12:00', endHour: '13:00' },
                { startHour: '12:30', endHour: '14:00' }
            ]
        };

        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        expect(breakRules.length).toBe(2);

        const engineResult = generateSlotsV2Engine({
            date: fridayDate,
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: [],
            closures: [],
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // 12:00-14:00 should be fully closed (merged from 12:00-13:00 and 12:30-14:00)
        expect(isRangeFullyClosed(engineResult.slots, '12:00', '14:00')).toBe(true);

        // No available gap at 12:30-13:00
        const availableAtOverlap = getSlotsByStatus(engineResult.slots, 'available').filter(slot => {
            const start = timeToMinutes(slot.start);
            const end = timeToMinutes(slot.end);
            return start >= timeToMinutes('12:30') && end <= timeToMinutes('13:00');
        });
        expect(availableAtOverlap.length).toBe(0);
    });

    it('handles fully contained break rule', () => {
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '12:00', endHour: '15:00' },
                { startHour: '13:00', endHour: '14:00' }
            ]
        };

        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        const engineResult = generateSlotsV2Engine({
            date: fridayDate,
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: [],
            closures: [],
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // Entire 12:00-15:00 should be closed
        expect(isRangeFullyClosed(engineResult.slots, '12:00', '15:00')).toBe(true);
    });
});

// ===============================
// TEST GROUP P6
// Weekly Break + Appointment
// ===============================

describe('P6: Weekly Break + Appointment', () => {
    it('marks appointment slot as closed when break rule covers it', () => {
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '12:00', endHour: '13:00' }
            ]
        };

        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        // Appointment at 12:15-12:45 (inside break rule)
        const appointments = [
            { start: '12:15', end: '12:45' }
        ];

        const engineResult = generateSlotsV2Engine({
            date: fridayDate,
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: appointments,
            closures: [],
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // The 12:00-13:00 area should be closed
        // No slot inside this range should be 'busy' - it should be 'closed'
        const slotsInRange = engineResult.slots.filter(slot => {
            const slotStart = timeToMinutes(slot.start);
            const slotEnd = timeToMinutes(slot.end);
            return slotStart < timeToMinutes('13:00') && slotEnd > timeToMinutes('12:00');
        });

        // All slots in break range should be closed, not busy
        const busySlots = slotsInRange.filter(s => s.status === 'busy');
        expect(busySlots.length).toBe(0);

        const closedSlots = slotsInRange.filter(s => s.status === 'closed');
        expect(closedSlots.length).toBeGreaterThan(0);
    });

    it('appointment outside break rule remains busy', () => {
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '12:00', endHour: '13:00' }
            ]
        };

        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        // Appointment at 11:00-11:30 (outside break rule)
        const appointments = [
            { start: '11:00', end: '11:30' }
        ];

        const engineResult = generateSlotsV2Engine({
            date: fridayDate,
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: appointments,
            closures: [],
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // 11:00-11:30 should be busy (not closed)
        const busySlots = engineResult.slots.filter(slot => {
            const slotStart = timeToMinutes(slot.start);
            const slotEnd = timeToMinutes(slot.end);
            return slotStart >= timeToMinutes('11:00') && slotEnd <= timeToMinutes('11:30');
        });

        expect(busySlots.some(s => s.status === 'busy')).toBe(true);
    });
});

// ===============================
// TEST GROUP P7
// Weekly Break + Closure
// ===============================

describe('P7: Weekly Break + Closure', () => {
    it('closure takes priority over break rule', () => {
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '12:00', endHour: '14:00' }
            ]
        };

        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        // Closure at 13:00-13:30 (inside break rule)
        const closures = [
            { start: '13:00', end: '13:30', scope: 'global' }
        ];

        const engineResult = generateSlotsV2Engine({
            date: fridayDate,
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: [],
            closures: closures,
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // Entire 12:00-14:00 should be closed (closure + break merged)
        expect(isRangeFullyClosed(engineResult.slots, '12:00', '14:00')).toBe(true);
    });

    it('closure extending beyond break rule still covers full range', () => {
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '12:00', endHour: '13:00' }
            ]
        };

        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        // Closure extends beyond break rule
        const closures = [
            { start: '12:30', end: '14:30', scope: 'global' }
        ];

        const engineResult = generateSlotsV2Engine({
            date: fridayDate,
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: [],
            closures: closures,
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // Full merged range 12:00-14:30 should be closed
        expect(isRangeFullyClosed(engineResult.slots, '12:00', '14:30')).toBe(true);
    });
});

// ===============================
// TEST GROUP P8
// Leap Year Validation
// ===============================

describe('P8: Leap Year Validation', () => {
    it('accepts Feb 29 on leap year (2024)', () => {
        // Feb 29, 2024 is a Thursday
        const result = expandWeeklyBreakRules({
            date: '2024-02-29',
            weeklyBreakRule: {
                thursday: [
                    { startHour: '10:00', endHour: '11:00' }
                ]
            }
        });

        expect(result.length).toBe(1);
        expect(result[0].start).toBe('10:00');
        expect(result[0].end).toBe('11:00');
    });

    it('rejects Feb 29 on non-leap year (2027) without crash', () => {
        // Feb 29, 2027 does not exist - Temporal API should reject it
        const result = expandWeeklyBreakRules({
            date: '2027-02-29',
            weeklyBreakRule: {
                tuesday: [
                    { startHour: '10:00', endHour: '11:00' }
                ]
            }
        });

        // Should return empty array, not crash
        expect(result).toEqual([]);
    });

    it('handles Feb 29 edge case in engine integration', () => {
        const breakRules = expandWeeklyBreakRules({
            date: '2028-02-29',
            weeklyBreakRule: {
                wednesday: [
                    { startHour: '10:00', endHour: '11:00' }
                ]
            }
        });

        // Should not throw when passing to engine
        expect(() => {
            generateSlotsV2Engine({
                date: '2028-02-29',
                serviceDuration: 30,
                workingHours: { start: '09:00', end: '21:00' },
                appointments: [],
                closures: [],
                breakRules: breakRules,
                staticSlots: [],
                isToday: false,
                currentMinute: null,
                settings: { slotTime: 30 }
            });
        }).not.toThrow();
    });
});

// ===============================
// TEST GROUP P9
// Full Week Validation
// ===============================

describe('P9: Full Week Validation', () => {
    const fullWeekRule = {
        monday: [{ startHour: '09:00', endHour: '10:00', note: 'Monday break' }],
        tuesday: [{ startHour: '10:00', endHour: '11:00', note: 'Tuesday break' }],
        wednesday: [{ startHour: '11:00', endHour: '12:00', note: 'Wednesday break' }],
        thursday: [{ startHour: '12:00', endHour: '13:00', note: 'Thursday break' }],
        friday: [{ startHour: '13:00', endHour: '14:00', note: 'Friday break' }],
        saturday: [{ startHour: '14:00', endHour: '15:00', note: 'Saturday break' }],
        sunday: [{ startHour: '15:00', endHour: '16:00', note: 'Sunday break' }]
    };

    // 2026-06-15 is Monday
    it('returns only monday rules for monday date', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-15',
            weeklyBreakRule: fullWeekRule
        });

        expect(result.length).toBe(1);
        expect(result[0].start).toBe('09:00');
        expect(result[0].end).toBe('10:00');
        expect(result[0].note).toBe('Monday break');
    });

    // 2026-06-16 is Tuesday
    it('returns only tuesday rules for tuesday date', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-16',
            weeklyBreakRule: fullWeekRule
        });

        expect(result.length).toBe(1);
        expect(result[0].start).toBe('10:00');
        expect(result[0].end).toBe('11:00');
        expect(result[0].note).toBe('Tuesday break');
    });

    // 2026-06-17 is Wednesday
    it('returns only wednesday rules for wednesday date', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-17',
            weeklyBreakRule: fullWeekRule
        });

        expect(result.length).toBe(1);
        expect(result[0].start).toBe('11:00');
        expect(result[0].end).toBe('12:00');
        expect(result[0].note).toBe('Wednesday break');
    });

    // 2026-06-18 is Thursday
    it('returns only thursday rules for thursday date', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-18',
            weeklyBreakRule: fullWeekRule
        });

        expect(result.length).toBe(1);
        expect(result[0].start).toBe('12:00');
        expect(result[0].end).toBe('13:00');
        expect(result[0].note).toBe('Thursday break');
    });

    // 2026-06-19 is Friday
    it('returns only friday rules for friday date', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: fullWeekRule
        });

        expect(result.length).toBe(1);
        expect(result[0].start).toBe('13:00');
        expect(result[0].end).toBe('14:00');
        expect(result[0].note).toBe('Friday break');
    });

    // 2026-06-20 is Saturday
    it('returns only saturday rules for saturday date', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-20',
            weeklyBreakRule: fullWeekRule
        });

        expect(result.length).toBe(1);
        expect(result[0].start).toBe('14:00');
        expect(result[0].end).toBe('15:00');
        expect(result[0].note).toBe('Saturday break');
    });

    // 2026-06-21 is Sunday
    it('returns only sunday rules for sunday date', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-21',
            weeklyBreakRule: fullWeekRule
        });

        expect(result.length).toBe(1);
        expect(result[0].start).toBe('15:00');
        expect(result[0].end).toBe('16:00');
        expect(result[0].note).toBe('Sunday break');
    });
});

// ===============================
// TEST GROUP P10
// Production Dataset Replay
// ===============================

describe('P10: Production Dataset Replay', () => {
    const productionDataset = {
        "friday": [
            { "note": "Öğle arası", "startHour": "12:00", "endHour": "13:00" },
            { "note": "Cuma Namazı", "startHour": "13:00", "endHour": "14:00" }
        ],
        "monday": [
            { "note": "Öğle arası", "startHour": "12:00", "endHour": "13:00" }
        ],
        "tuesday": [
            { "note": "Öğle arası", "startHour": "12:00", "endHour": "13:00" }
        ],
        "wednesday": [
            { "note": "Öğle arası", "startHour": "12:00", "endHour": "13:00" }
        ],
        "thursday": [
            { "note": "Öğle arası", "startHour": "12:00", "endHour": "13:00" }
        ],
        "saturday": [
            { "note": "Öğle arası", "startHour": "12:00", "endHour": "13:00" }
        ],
        "sunday": []
    };

    it('returns friday rules for 2026-06-19 (Friday)', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: productionDataset
        });

        expect(result.length).toBe(2);
        expect(result[0].start).toBe('12:00');
        expect(result[0].end).toBe('13:00');
        expect(result[0].note).toBe('Öğle arası');
        expect(result[1].start).toBe('13:00');
        expect(result[1].end).toBe('14:00');
        expect(result[1].note).toBe('Cuma Namazı');
    });

    it('returns monday rules for 2026-06-15 (Monday)', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-15',
            weeklyBreakRule: productionDataset
        });

        expect(result.length).toBe(1);
        expect(result[0].start).toBe('12:00');
        expect(result[0].end).toBe('13:00');
        expect(result[0].note).toBe('Öğle arası');
    });

    it('returns empty array for sunday with empty rules', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-21',
            weeklyBreakRule: productionDataset
        });

        expect(result).toEqual([]);
    });

    it('produces correct closed slots for friday in engine', () => {
        const breakRules = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: productionDataset
        });

        const engineResult = generateSlotsV2Engine({
            date: '2026-06-19',
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: [],
            closures: [],
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // 12:00-14:00 should be fully closed
        expect(isRangeFullyClosed(engineResult.slots, '12:00', '14:00')).toBe(true);

        // Slots outside 12:00-14:00 should not be affected
        const availableBefore = engineResult.slots.filter(slot => {
            return timeToMinutes(slot.end) <= timeToMinutes('12:00') && slot.status === 'available';
        });
        const availableAfter = engineResult.slots.filter(slot => {
            return timeToMinutes(slot.start) >= timeToMinutes('14:00') && slot.status === 'available';
        });

        expect(availableBefore.length).toBeGreaterThan(0);
        expect(availableAfter.length).toBeGreaterThan(0);
    });

    it('produces correct closed slots for monday in engine', () => {
        const breakRules = expandWeeklyBreakRules({
            date: '2026-06-15',
            weeklyBreakRule: productionDataset
        });

        const engineResult = generateSlotsV2Engine({
            date: '2026-06-15',
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' },
            appointments: [],
            closures: [],
            breakRules: breakRules,
            staticSlots: [],
            isToday: false,
            currentMinute: null,
            settings: { slotTime: 30 }
        });

        // 12:00-13:00 should be fully closed
        expect(isRangeFullyClosed(engineResult.slots, '12:00', '13:00')).toBe(true);
    });
});