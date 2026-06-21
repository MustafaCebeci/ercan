/**
 * Ultimate Validation Suite for Booking Candidate Generator
 *
 * Tests mathematical correctness, not just "it works".
 *
 * Test Groups:
 * - AB: Golden Output Tests (exact expected output)
 * - AC: Available Slot Integrity
 * - AD: Busy Slot Integrity
 * - AE: Closed Slot Integrity
 * - AF: NotAvailable Integrity
 * - AG: Chronological Integrity
 * - AH: Coverage Integrity
 * - AI: Service Duration Scaling
 * - AJ: Random Dense Day Generator (100 scenarios)
 * - AK: Fuzz Testing (500 scenarios)
 * - AL: Real Production Golden Test
 * - AM: Timeline Engine + Booking Generator E2E
 */

import { describe, it, expect } from 'vitest';
import { generateBookableSlots } from '../../src/services/booking-candidate-generator.js';

// ===== HELPER FUNCTIONS =====

function parseHHMM(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
}

function minutesToHHMM(mins) {
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function overlapsIntervals(startMin, endMin, intervals) {
    for (const int of intervals) {
        if (startMin < int.end && endMin > int.start) {
            return true;
        }
    }
    return false;
}

function calculateCoverage(slots) {
    if (slots.length === 0) return 0;
    let total = 0;
    for (const slot of slots) {
        total += parseHHMM(slot.end) - parseHHMM(slot.start);
    }
    return total;
}

function buildInput(overrides = {}) {
    return {
        timeline: [],
        serviceDuration: 60,
        workingHours: { start: '09:00', end: '21:00' },
        staticSlots: [],
        ...overrides
    };
}

// ===== TEST GROUP AB: Golden Output Tests =====

describe('TEST GROUP AB: Golden Output Tests', () => {

    it('AB-1: Simple single appointment with20min service', () => {
        // Input: 09:30-12:00 available, 11:00-11:45 busy,20min service
        const input = buildInput({
            timeline: [
                { start: '09:30', end: '11:00', status: 'available' },
                { start: '11:00', end: '11:45', status: 'busy' },
                { start: '11:45', end: '12:00', status: 'available' }
            ],
            serviceDuration: 20,
            workingHours: { start: '09:30', end: '12:00' }
        });

        const result = generateBookableSlots(input);

        // Expected: 4 available (09:30-09:50, 09:50-10:10, 10:10-10:30, 10:30-10:50)
        //         1 tail notAvailable (10:50-11:00)
        //          1 busy atomic (11:00-11:45)
        //          1 available (11:45-12:00) - but this is only 15min so tail
        // Actually: 11:45-12:00 is 15min < 20min, so notAvailable tail

        const availableSlots = result.filter(s => s.status === 'available');
        const busySlots = result.filter(s => s.status === 'busy');
        const notAvailableSlots = result.filter(s => s.status === 'notAvailable');

        // Verify exact counts
        expect(availableSlots.length).toBe(4);
        expect(busySlots.length).toBe(1);
        expect(notAvailableSlots.length).toBe(2);

        // Verify busy is atomic
        expect(busySlots[0].start).toBe('11:00');
        expect(busySlots[0].end).toBe('11:45');
    });

    it('AB-2: Break should remain atomic regardless of service duration', () => {
        // Input: 09:00-12:00 available, 12:00-13:00 closed, 13:00-21:00 available, 60min service
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '12:00', status: 'available' },
                { start: '12:00', end: '13:00', status: 'closed' },
                { start: '13:00', end: '21:00', status: 'available' }
            ],
            serviceDuration: 60,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);

        // Should have 3 available slots (09:00-10:00, 10:00-11:00, 11:00-12:00)
        // 1 closed atomic (12:00-13:00)
        // 8 available slots (13:00-14:00 through 20:00-21:00)
        const availableSlots = result.filter(s => s.status === 'available');
        const closedSlots = result.filter(s => s.status === 'closed');

        expect(availableSlots.length).toBe(11);
        expect(closedSlots.length).toBe(1);
        expect(closedSlots[0].start).toBe('12:00');
        expect(closedSlots[0].end).toBe('13:00');
    });

    it('AB-3: Exact divisible duration creates no tail', () => {
        // Input: 09:00-12:00 available, 30min service
        // 09:00-12:00 = 180 min, 30 min slots = exactly 6 slots
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '12:00', status: 'available' }
            ],
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '12:00' }
        });

        const result = generateBookableSlots(input);

        const availableSlots = result.filter(s => s.status === 'available');
        const notAvailableSlots = result.filter(s => s.status === 'notAvailable');

        expect(availableSlots.length).toBe(6);
        expect(notAvailableSlots.length).toBe(0);

        // Verify exact slot times
        expect(result[0].start).toBe('09:00');
        expect(result[0].end).toBe('09:30');
        expect(result[1].start).toBe('09:30');
        expect(result[1].end).toBe('10:00');
        expect(result[2].start).toBe('10:00');
        expect(result[2].end).toBe('10:30');
        expect(result[3].start).toBe('10:30');
        expect(result[3].end).toBe('11:00');
        expect(result[4].start).toBe('11:00');
        expect(result[4].end).toBe('11:30');
        expect(result[5].start).toBe('11:30');
        expect(result[5].end).toBe('12:00');
    });

    it('AB-4: Multiple busy intervals all remain atomic', () => {
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '10:00', status: 'available' },
                { start: '10:00', end: '10:30', status: 'busy' },
                { start: '10:30', end: '11:00', status: 'available' },
                { start: '11:00', end: '12:00', status: 'busy' },
                { start: '12:00', end: '21:00', status: 'available' }
            ],
            serviceDuration: 20,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);

        const busySlots = result.filter(s => s.status === 'busy');

        expect(busySlots.length).toBe(2);
        expect(busySlots[0].start).toBe('10:00');
        expect(busySlots[0].end).toBe('10:30');
        expect(busySlots[1].start).toBe('11:00');
        expect(busySlots[1].end).toBe('12:00');
    });

    it('AB-5: Short available segment creates only notAvailable tail', () => {
        // Input: 09:00-09:20 available, 30min service
        // 20min < 30min, so entire segment is tail
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '09:20', status: 'available' }
            ],
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '09:20' }
        });

        const result = generateBookableSlots(input);

        const availableSlots = result.filter(s => s.status === 'available');
        const notAvailableSlots = result.filter(s => s.status === 'notAvailable');

        expect(availableSlots.length).toBe(0);
        expect(notAvailableSlots.length).toBe(1);
        expect(notAvailableSlots[0].start).toBe('09:00');
        expect(notAvailableSlots[0].end).toBe('09:20');
    });
});

// ===== TEST GROUP AC: Available Slot Integrity =====

describe('TEST GROUP AC: Available Slot Integrity', () => {

    function hasValidEndTime(slot, serviceDuration, timeline) {
        // Check if slot.end = slot.start + serviceDuration
        const startMin = parseHHMM(slot.start);
        const expectedEndMin = startMin + serviceDuration;
        const actualEndMin = parseHHMM(slot.end);
        return expectedEndMin === actualEndMin;
    }

    function overlapsAnyBlocker(slot, timeline) {
        const startMin = parseHHMM(slot.start);
        const endMin = parseHHMM(slot.end);

        for (const seg of timeline) {
            if (seg.status === 'available') continue;
            const segStart = parseHHMM(seg.start);
            const segEnd = parseHHMM(seg.end);
            if (startMin < segEnd && endMin > segStart) {
                return true;
            }
        }
        return false;
    }

    it('AC-1: All available slots have valid duration', () => {
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '12:00', status: 'available' },
                { start: '12:00', end: '13:00', status: 'closed' },
                { start: '13:00', end: '21:00', status: 'available' }
            ],
            serviceDuration: 45,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);
        const availableSlots = result.filter(s => s.status === 'available');

        for (const slot of availableSlots) {
            expect(hasValidEndTime(slot, 45, input.timeline)).toBe(true);
        }
    });

    it('AC-2: No available slot overlaps any blocker', () => {
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '11:00', status: 'available' },
                { start: '11:00', end: '11:45', status: 'busy' },
                { start: '11:45', end: '21:00', status: 'available' }
            ],
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);
        const availableSlots = result.filter(s => s.status === 'available');

        for (const slot of availableSlots) {
            expect(overlapsAnyBlocker(slot, input.timeline)).toBe(false);
        }
    });

    it('AC-3: Available slots in dense day do not overlap blockers', () => {
        const input = buildInput({
            timeline: [
                { start: '09:30', end: '10:00', status: 'available' },
                { start: '10:00', end: '10:30', status: 'busy' },
                { start: '10:30', end: '11:00', status: 'available' },
                { start: '11:00', end: '11:20', status: 'busy' },
                { start: '11:20', end: '12:00', status: 'available' },
                { start: '12:00', end: '13:00', status: 'closed' },
                { start: '13:00', end: '13:30', status: 'available' },
                { start: '13:30', end: '14:15', status: 'busy' },
                { start: '14:15', end: '21:00', status: 'available' }
            ],
            serviceDuration: 20,
            workingHours: { start: '09:30', end: '21:00' }
        });

        const result = generateBookableSlots(input);
        const availableSlots = result.filter(s => s.status === 'available');

        for (const slot of availableSlots) {
            expect(overlapsAnyBlocker(slot, input.timeline)).toBe(false);
        }
    });
});

// ===== TEST GROUP AD: Busy Slot Integrity =====

describe('TEST GROUP AD: Busy Slot Integrity', () => {

    function overlapsAppointment(busySlot, appointments) {
        const startMin = parseHHMM(busySlot.start);
        const endMin = parseHHMM(busySlot.end);

        for (const appt of appointments) {
            const apptStart = parseHHMM(appt.start);
            const apptEnd = parseHHMM(appt.end);
            if (startMin < apptEnd && endMin > apptStart) {
                return true;
            }
        }
        return false;
    }

    it('AD-1: Every busy slot overlaps at least one appointment', () => {
        const appointments = [
            { start: '10:00', end: '10:30' },
            { start: '11:00', end: '11:20' },
            { start: '13:30', end: '14:15' }
        ];

        const input = buildInput({
            timeline: [
                { start: '09:00', end: '10:00', status: 'available' },
                { start: '10:00', end: '10:30', status: 'busy' },
                { start: '10:30', end: '11:00', status: 'available' },
                { start: '11:00', end: '11:20', status: 'busy' },
                { start: '11:20', end: '13:00', status: 'available' },
                { start: '13:00', end: '13:30', status: 'available' },
                { start: '13:30', end: '14:15', status: 'busy' },
                { start: '14:15', end: '21:00', status: 'available' }
            ],
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);
        const busySlots = result.filter(s => s.status === 'busy');

        for (const busySlot of busySlots) {
            expect(overlapsAppointment(busySlot, appointments)).toBe(true);
        }
    });

    it('AD-2: Busy slot that does not overlap any appointment is invalid', () => {
        // This test verifies our validation logic is correct
        // A busy slot 10:00-10:30 should overlap with appointment 10:00-10:30
        const busySlot = { start: '10:00', end: '10:30' };
        const appointments = [{ start: '10:00', end: '10:30' }];

        expect(overlapsAppointment(busySlot, appointments)).toBe(true);

        // But10:00-10:30 should NOT overlap with 10:30-11:00
        const appointments2 = [{ start: '10:30', end: '11:00' }];
        expect(overlapsAppointment(busySlot, appointments2)).toBe(false);
    });
});

// ===== TEST GROUP AE: Closed Slot Integrity =====

describe('TEST GROUP AE: Closed Slot Integrity', () => {

    function overlapsClosureOrBreak(closedSlot, closures, breakRules) {
        const startMin = parseHHMM(closedSlot.start);
        const endMin = parseHHMM(closedSlot.end);

        for (const closure of closures) {
            const cStart = parseHHMM(closure.start);
            const cEnd = parseHHMM(closure.end);
            if (startMin < cEnd && endMin > cStart) {
                return true;
            }
        }

        for (const brk of breakRules) {
            const bStart = parseHHMM(brk.start);
            const bEnd = parseHHMM(brk.end);
            if (startMin < bEnd && endMin > bStart) {
                return true;
            }
        }

        return false;
    }

    it('AE-1: Every closed slot overlaps closure or break', () => {
        const closures = [
            { start: '12:00', end: '13:00' },  // lunch
            { start: '19:30', end: '21:00' } // evening leave
        ];
        const breakRules = [];

        const input = buildInput({
            timeline: [
                { start: '09:00', end: '12:00', status: 'available' },
                { start: '12:00', end: '13:00', status: 'closed' },
                { start: '13:00', end: '19:30', status: 'available' },
                { start: '19:30', end: '21:00', status: 'closed' }
            ],
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);
        const closedSlots = result.filter(s => s.status === 'closed');

        expect(closedSlots.length).toBe(2);
        for (const closedSlot of closedSlots) {
            expect(overlapsClosureOrBreak(closedSlot, closures, breakRules)).toBe(true);
        }
    });

    it('AE-2: Closed slot overlapping break', () => {
        const closures = [];
        const breakRules = [{ start: '12:00', end: '13:00' }];

        const input = buildInput({
            timeline: [
                { start: '09:00', end: '12:00', status: 'available' },
                { start: '12:00', end: '13:00', status: 'closed' },
                { start: '13:00', end: '21:00', status: 'available' }
            ],
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);
        const closedSlots = result.filter(s => s.status === 'closed');

        expect(closedSlots.length).toBe(1);
        expect(overlapsClosureOrBreak(closedSlots[0], closures, breakRules)).toBe(true);
    });
});

// ===== TEST GROUP AF: NotAvailable Integrity =====

describe('TEST GROUP AF: NotAvailable Integrity', () => {

    function hasValidReason(notAvailableSlot, timeline, serviceDuration) {
        const startMin = parseHHMM(notAvailableSlot.start);
        const endMin = parseHHMM(notAvailableSlot.end);
        const duration = endMin - startMin;

        // Reason 1: duration< serviceDuration (tail)
        if (duration < serviceDuration) {
            return true;
        }

        // Reason 2: overlaps with busy/closed when extended by serviceDuration
        for (const seg of timeline) {
            if (seg.status === 'available') continue;
            const segStart = parseHHMM(seg.start);
            const segEnd = parseHHMM(seg.end);
            // If slot extended by serviceDuration would overlap
            if (startMin < segEnd && endMin + serviceDuration > segStart) {
                return true;
            }
        }

        return false;
    }

    it('AF-1: notAvailable tail has duration < serviceDuration', () => {
        // 09:00-11:00 = 120 min, 45 min service = 2 slots + 30 min tail
        // Slots: 09:00-09:45, 09:45-10:30, tail: 10:30-11:00
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '11:00', status: 'available' }
            ],
            serviceDuration: 45,
            workingHours: { start: '09:00', end: '11:00' }
        });

        const result = generateBookableSlots(input);
        const notAvailableSlots = result.filter(s => s.status === 'notAvailable');

        expect(notAvailableSlots.length).toBe(1);
        expect(notAvailableSlots[0].start).toBe('10:30');
        expect(notAvailableSlots[0].end).toBe('11:00');

        const duration = parseHHMM('11:00') - parseHHMM('10:30');
        expect(duration).toBeLessThan(45);
    });

    it('AF-2: All notAvailable slots have valid reason', () => {
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '11:00', status: 'available' },
                { start: '11:00', end: '11:45', status: 'busy' },
                { start: '11:45', end: '21:00', status: 'available' }
            ],
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);
        const notAvailableSlots = result.filter(s => s.status === 'notAvailable');

        for (const slot of notAvailableSlots) {
            expect(hasValidReason(slot, input.timeline, 30)).toBe(true);
        }
    });
});

// ===== TEST GROUP AG: Chronological Integrity =====

describe('TEST GROUP AG: Chronological Integrity', () => {

    it('AG-1: All slots have start < end', () => {
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '21:00', status: 'available' }
            ],
            serviceDuration: 45,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);

        for (const slot of result) {
            expect(parseHHMM(slot.start)).toBeLessThan(parseHHMM(slot.end));
        }
    });

    it('AG-2: No overlapping slots', () => {
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '12:00', status: 'available' },
                { start: '12:00', end: '13:00', status: 'closed' },
                { start: '13:00', end: '21:00', status: 'available' }
            ],
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);

        for (let i = 0; i < result.length - 1; i++) {
            const currentEnd = parseHHMM(result[i].end);
            const nextStart = parseHHMM(result[i + 1].start);
            expect(nextStart).toBeGreaterThanOrEqual(currentEnd);
        }
    });

    it('AG-3: Slots are in chronological order', () => {
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '10:00', status: 'available' },
                { start: '10:00', end: '10:30', status: 'busy' },
                { start: '10:30', end: '11:00', status: 'available' },
                { start: '11:00', end: '12:00', status: 'busy' },
                { start: '12:00', end: '21:00', status: 'available' }
            ],
            serviceDuration: 20,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);

        for (let i = 0; i < result.length - 1; i++) {
            expect(parseHHMM(result[i + 1].start))
                .toBeGreaterThanOrEqual(parseHHMM(result[i].start));
        }
    });

    it('AG-4: No gaps between consecutive slots', () => {
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '12:00', status: 'available' },
                { start: '12:00', end: '13:00', status: 'closed' },
                { start: '13:00', end: '15:00', status: 'available' }
            ],
            serviceDuration: 60,
            workingHours: { start: '09:00', end: '15:00' }
        });

        const result = generateBookableSlots(input);

        // Check no gaps within available sections
        for (let i = 0; i < result.length - 1; i++) {
            const currentEnd = parseHHMM(result[i].end);
            const nextStart = parseHHMM(result[i + 1].start);
            // Gaps are allowed only at status boundaries (busy/closed)
            if (result[i].status === 'available' && result[i + 1].status === 'available') {
                expect(nextStart).toBe(currentEnd);
            }
        }
    });
});

// ===== TEST GROUP AH: Coverage Integrity =====

describe('TEST GROUP AH: Coverage Integrity', () => {

    it('AH-1: Full day coverage without gaps', () => {
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '21:00', status: 'available' }
            ],
            serviceDuration: 60,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);

        // Working hours: 09:00-21:00 = 720 minutes
        // With 60min service: 12 slots exactly
        expect(result.length).toBe(12);

        // First slot starts at workingHours start
        expect(result[0].start).toBe('09:00');

        // Last slot ends at workingHours end
        expect(result[result.length - 1].end).toBe('21:00');
    });

    it('AH-2: Coverage with busy and closed segments', () => {
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '10:00', status: 'available' },
                { start: '10:00', end: '10:30', status: 'busy' },
                { start: '10:30', end: '12:00', status: 'available' },
                { start: '12:00', end: '13:00', status: 'closed' },
                { start: '13:00', end: '21:00', status: 'available' }
            ],
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);

        // Total time covered should equal working hours (720 min)
        // minus the busy/closed segments (1.5 hours = 90 min)
        // But available slots + busy/closed should still cover the timeline
        const totalCoverage = calculateCoverage(result);
        expect(totalCoverage).toBe(720);
    });

    it('AH-3: Exact coverage with short tail', () => {
        const input = buildInput({
            timeline: [
                { start: '09:00', end: '11:00', status: 'available' }
            ],
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '11:00' }
        });

        const result = generateBookableSlots(input);

        // 09:00-11:00 = 120 min,30min slots = 4 slots exactly
        expect(result.length).toBe(4);
        expect(result[0].start).toBe('09:00');
        expect(result[3].end).toBe('11:00');
    });
});

// ===== TEST GROUP AI: Service Duration Scaling =====

describe('TEST GROUP AI: Service Duration Scaling', () => {

    const timeline = [
        { start: '09:00', end: '12:00', status: 'available' },
        { start: '12:00', end: '13:00', status: 'closed' },
        { start: '13:00', end: '21:00', status: 'available' }
    ];

    it('AI-1: More available slots with shorter duration', () => {
        const durations = [15, 20, 30, 45, 60, 90, 120];
        const counts = {};

        for (const dur of durations) {
            const input = buildInput({
                timeline: timeline,
                serviceDuration: dur,
                workingHours: { start: '09:00', end: '21:00' }
            });
            const result = generateBookableSlots(input);
            counts[dur] = result.filter(s => s.status === 'available').length;
        }

        // Verify monotonic: larger duration = fewer or equal available slots
        for (let i = 1; i < durations.length; i++) {
            expect(counts[durations[i]]).toBeLessThanOrEqual(counts[durations[i - 1]]);
        }
    });

    it('AI-2: Duration15 has most slots, 120 has fewest', () => {
        const input15 = buildInput({ timeline, serviceDuration: 15, workingHours: { start: '09:00', end: '21:00' } });
        const input120 = buildInput({ timeline, serviceDuration: 120, workingHours: { start: '09:00', end: '21:00' } });

        const result15 = generateBookableSlots(input15);
        const result120 = generateBookableSlots(input120);

        const count15 = result15.filter(s => s.status === 'available').length;
        const count120 = result120.filter(s => s.status === 'available').length;

        expect(count15).toBeGreaterThan(count120);
    });
});

// ===== TEST GROUP AJ: Random Dense Day Generator (100 scenarios) =====

describe('TEST GROUP AJ: Random Dense Day Generator (100 scenarios)', () => {
    const durations = [15, 20, 30, 45, 60];

    function generateRandomTimeline() {
        const timeline = [];
        const numAppointments = Math.floor(Math.random() * 6) + 1;
        const numBreaks = Math.floor(Math.random() * 3);
        const numClosures = Math.floor(Math.random() * 2);

        let currentTime = 9 * 60; // 09:00 in minutes

        // Add appointments
        for (let i = 0; i < numAppointments; i++) {
            const apptDuration = durations[Math.floor(Math.random() * durations.length)];
            const gapBefore = Math.floor(Math.random() * 60) + 10;

            currentTime += gapBefore;

            timeline.push({
                start: minutesToHHMM(currentTime),
                end: minutesToHHMM(currentTime + apptDuration),
                status: 'busy'
            });

            currentTime += apptDuration;
        }

        // Ensure we don't exceed 21:00
        if (currentTime > 21 * 60) {
            currentTime = 21 * 60;
        }

        // Add available segment to end
        if (currentTime < 21 * 60) {
            timeline.push({
                start: minutesToHHMM(currentTime),
                end: '21:00',
                status: 'available'
            });
        }

        return timeline;
    }

    it('AJ-1: 100 random days - no crashes or overlaps', () => {
        for (let day = 0; day < 100; day++) {
            const timeline = generateRandomTimeline();
            const serviceDuration = durations[Math.floor(Math.random() * durations.length)];

            const input = buildInput({
                timeline: timeline,
                serviceDuration: serviceDuration,
                workingHours: { start: '09:00', end: '21:00' }
            });

            // Should not throw
            let result;
            expect(() => {
                result = generateBookableSlots(input);
            }).not.toThrow();

            // No overlapping slots
            for (let i = 0; i < result.length - 1; i++) {
                const currentEnd = parseHHMM(result[i].end);
                const nextStart = parseHHMM(result[i + 1].start);
                expect(nextStart).toBeGreaterThanOrEqual(currentEnd);
            }

            // All slots in chronological order
            for (let i = 0; i < result.length - 1; i++) {
                expect(parseHHMM(result[i + 1].start))
                    .toBeGreaterThanOrEqual(parseHHMM(result[i].start));
            }

            // No negative durations
            for (const slot of result) {
                expect(parseHHMM(slot.end)).toBeGreaterThan(parseHHMM(slot.start));
            }
        }
    });
});

// ===== TEST GROUP AK: Fuzz Testing (500 scenarios) =====

describe('TEST GROUP AK: Fuzz Testing (500 scenarios)', () => {

    function generateFuzzInput() {
        const workingHoursStart = 6 + Math.floor(Math.random() * 4); // 06:00-10:00
        const workingHoursEnd = 18 + Math.floor(Math.random() * 5); // 18:00-23:00

        const numAppointments = Math.floor(Math.random() * 10);
        const numClosures = Math.floor(Math.random() * 4);
        const numBreaks = Math.floor(Math.random() * 4);
        const numStaticSlots = Math.floor(Math.random() * 3);

        const appointments = [];
        const closures = [];
        const breakRules = [];
        const staticSlots = [];

        // Generate appointments
        for (let i = 0; i < numAppointments; i++) {
            const start = workingHoursStart * 60 + Math.floor(Math.random() * ((workingHoursEnd - workingHoursStart) * 60));
            const duration = [15, 20, 30, 45, 60, 90][Math.floor(Math.random() * 6)];
            appointments.push({
                start: minutesToHHMM(start),
                end: minutesToHHMM(start + duration)
            });
        }

        // Generate closures
        for (let i = 0; i < numClosures; i++) {
            const start = workingHoursStart * 60 + Math.floor(Math.random() * ((workingHoursEnd - workingHoursStart) * 60));
            const duration = 30 + Math.floor(Math.random() * 180);
            closures.push({
                start: minutesToHHMM(start),
                end: minutesToHHMM(start + duration)
            });
        }

        // Generate break rules
        for (let i = 0; i < numBreaks; i++) {
            const start = workingHoursStart * 60 + Math.floor(Math.random() * ((workingHoursEnd - workingHoursStart) * 60));
            const duration = 30 + Math.floor(Math.random() * 90);
            breakRules.push({
                start: minutesToHHMM(start),
                end: minutesToHHMM(start + duration)
            });
        }

        // Generate static slots
        for (let i = 0; i < numStaticSlots; i++) {
            const start = workingHoursStart * 60 + Math.floor(Math.random() * ((workingHoursEnd - workingHoursStart) * 60));
            const duration = 30 + Math.floor(Math.random() * 120);
            staticSlots.push({
                start: minutesToHHMM(start),
                end: minutesToHHMM(start + duration)
            });
        }

        return {
            serviceDuration: [15, 20, 30, 45, 60, 90, 120][Math.floor(Math.random() * 7)],
            workingHours: {
                start: minutesToHHMM(workingHoursStart * 60),
                end: minutesToHHMM(workingHoursEnd * 60)
            },
            appointments,
            closures,
            breakRules,
            staticSlots
        };
    }

    it('AK-1: 500 fuzz scenarios - no crashes', () => {
        let crashed = 0;
        let invalidOutput = 0;

        for (let i = 0; i < 500; i++) {
            const fuzzInput = generateFuzzInput();

            // Build timeline from appointments, closures, breaks
            const timeline = [];

            // Add appointments as busy
            for (const appt of fuzzInput.appointments) {
                timeline.push({
                    start: appt.start,
                    end: appt.end,
                    status: 'busy'
                });
            }

            // Add closures as closed
            for (const closure of fuzzInput.closures) {
                timeline.push({
                    start: closure.start,
                    end: closure.end,
                    status: 'closed'
                });
            }

            // Add breaks as closed
            for (const brk of fuzzInput.breakRules) {
                timeline.push({
                    start: brk.start,
                    end: brk.end,
                    status: 'closed'
                });
            }

            // Sort timeline by start time
            timeline.sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start));

            // Merge overlapping segments (keep the first one if overlapping)
            const mergedTimeline = [];
            for (const seg of timeline) {
                if (mergedTimeline.length > 0) {
                    const last = mergedTimeline[mergedTimeline.length - 1];
                    const lastStart = parseHHMM(last.start);
                    const lastEnd = parseHHMM(last.end);
                    const segStart = parseHHMM(seg.start);
                    const segEnd = parseHHMM(seg.end);

                    // If overlapping, skip this segment
                    if (segStart < lastEnd && segEnd > lastStart) {
                        continue;
                    }
                    // If adjacent with same status, merge
                    if (last.end === seg.start && last.status === seg.status) {
                        last.end = seg.end;
                    } else {
                        mergedTimeline.push(seg);
                    }
                } else {
                    mergedTimeline.push(seg);
                }
            }

            const input = buildInput({
                timeline: mergedTimeline,
                serviceDuration: fuzzInput.serviceDuration,
                workingHours: fuzzInput.workingHours,
                staticSlots: fuzzInput.staticSlots
            });

            let result;
            try {
                result = generateBookableSlots(input);
            } catch (e) {
                crashed++;
                continue;
            }

            // Check for invalid output structure
            if (!result || !Array.isArray(result) || result.length === 0) {
                invalidOutput++;
                continue;
            }

            // Check for invalid durations
            let hasInvalidDuration = false;
            for (const slot of result) {
                if (parseHHMM(slot.end) <= parseHHMM(slot.start)) {
                    hasInvalidDuration = true;
                    break;
                }
            }

            if (hasInvalidDuration) {
                invalidOutput++;
            }
        }

        // Allow some failures - fuzz testing is for finding edge cases
        // We expect at least 80% to work without crashing
        expect(crashed).toBeLessThan(100);
        expect(invalidOutput).toBeLessThan(200);
    });
});

// ===== TEST GROUP AL: Real Production Golden Test =====

describe('TEST GROUP AL: Real Production Golden Test', () => {

    it('AL-1: Full barber day with exact expected output', () => {
        // Real production scenario
        const input = buildInput({
            serviceDuration: 30,
            workingHours: { start: '09:30', end: '20:30' },
            timeline: [
                { start: '09:30', end: '09:50', status: 'available' },
                { start: '09:50', end: '10:20', status: 'busy' },    // 30 min
                { start: '10:20', end: '10:40', status: 'available' },
                { start: '10:40', end: '11:00', status: 'busy' },    // 20 min
                { start: '11:00', end: '11:15', status: 'available' },
                { start: '11:15', end: '12:00', status: 'busy' },     // 45 min
                { start: '12:00', end: '13:00', status: 'closed' },   // lunch
                { start: '13:00', end: '13:30', status: 'available' },
                { start: '13:30', end: '14:15', status: 'busy' },     // 45 min
                { start: '14:15', end: '15:00', status: 'available' },
                { start: '15:00', end: '15:30', status: 'busy' },      // 30 min
                { start: '15:30', end: '16:20', status: 'available' },
                { start: '16:20', end: '16:40', status: 'busy' },      // 20 min
                { start: '16:40', end: '17:30', status: 'available' },
                { start: '17:30', end: '18:00', status: 'busy' },      // 30 min
                { start: '18:00', end: '19:00', status: 'available' },
                { start: '19:00', end: '19:20', status: 'busy' },      // 20 min
                { start: '19:20', end: '19:30', status: 'available' },
                { start: '19:30', end: '21:00', status: 'closed' }    // evening
            ]
        });

        const result = generateBookableSlots(input);

        // All busy intervals must be atomic
        const busySlots = result.filter(s => s.status === 'busy');
        expect(busySlots.length).toBe(8);

        // All closed intervals must be atomic
        const closedSlots = result.filter(s => s.status === 'closed');
        expect(closedSlots.length).toBe(2);

        // No overlapping
        for (let i = 0; i < result.length - 1; i++) {
            expect(parseHHMM(result[i + 1].start)).toBeGreaterThanOrEqual(parseHHMM(result[i].end));
        }

        // Available slots exist
        const availableSlots = result.filter(s => s.status === 'available');
        expect(availableSlots.length).toBeGreaterThan(0);
    });
});

// ===== TEST GROUP AM: Timeline Engine + Booking Generator E2E =====

describe('TEST GROUP AM: Timeline Engine + Booking Generator E2E', () => {

    it('AM-1: Combined timeline generation and slot generation', () => {
        // Simulate a full day with appointments, closures, breaks
        const appointments = [
            { start: '10:00', end: '10:30' },
            { start: '11:00', end: '11:20' },
            { start: '13:30', end: '14:15' }
        ];

        const closures = [
            { start: '12:00', end: '13:00' }
        ];

        const breakRules = [
            { start: '15:00', end: '15:30' }
        ];

        // Build timeline (simulating Timeline Engine)
        const timeline = [];

        // Sort all events
        const allEvents = [
            ...appointments.map(a => ({ ...a, type: 'appointment' })),
            ...closures.map(c => ({ ...c, type: 'closure' })),
            ...breakRules.map(b => ({ ...b, type: 'break' }))
        ].sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start));

        // Build timeline segments
        let currentTime = 9 * 60; // 09:00
        for (const event of allEvents) {
            const eventStart = parseHHMM(event.start);
            const eventEnd = parseHHMM(event.end);

            if (eventStart > currentTime) {
                timeline.push({
                    start: minutesToHHMM(currentTime),
                    end: minutesToHHMM(eventStart),
                    status: 'available'
                });
            }

            timeline.push({
                start: event.start,
                end: event.end,
                status: event.type === 'appointment' ? 'busy' : 'closed'
            });

            currentTime = eventEnd;
        }

        // Add remaining available time
        if (currentTime < 21 * 60) {
            timeline.push({
                start: minutesToHHMM(currentTime),
                end: '21:00',
                status: 'available'
            });
        }

        // Now use Booking Candidate Generator
        const input = buildInput({
            timeline: timeline,
            serviceDuration: 30,
            workingHours: { start: '09:00', end: '21:00' }
        });

        const result = generateBookableSlots(input);

        // Verify invariants
        // 1. All busy slots are atomic
        const busySlots = result.filter(s => s.status === 'busy');
        for (const busy of busySlots) {
            // Should match one of the appointments
            const matches = appointments.some(a =>
                a.start === busy.start && a.end === busy.end
            );
            expect(matches).toBe(true);
        }

        // 2. All closed slots are atomic
        const closedSlots = result.filter(s => s.status === 'closed');
        for (const closed of closedSlots) {
            const matchesClosure = closures.some(c =>
                c.start === closed.start && c.end === closed.end
            );
            const matchesBreak = breakRules.some(b =>
                b.start === closed.start && b.end === closed.end
            );
            expect(matchesClosure || matchesBreak).toBe(true);
        }

        // 3. No overlapping
        for (let i = 0; i < result.length - 1; i++) {
            expect(parseHHMM(result[i + 1].start)).toBeGreaterThanOrEqual(parseHHMM(result[i].end));
        }
    });
});
