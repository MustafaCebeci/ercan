/**
 * Booking Candidate Generator - Unit Tests (ATOMIC BEHAVIOR)
 *
 * Tests the generateBookableSlots function which produces
 * actual reservation start points from timeline segments.
 *
 * ATOMIC BEHAVIOR RULES:
 * - busy/closed segments are kept ATOMIC (not split by service duration)
 * - available segments are split by service duration
 * - short tails (remaining time < serviceDuration) are marked notAvailable
 * - static slots override service duration behavior
 * - empty timeline treated as all available within working hours
 */

import { describe, it, expect } from 'vitest';
import { generateBookableSlots } from '../../src/services/booking-candidate-generator.js';

// Helper
function parseHHMM(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
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

describe('generateBookableSlots', () => {

    // ===== TEST GROUP 1: Basic Service Duration Slots =====
    describe('TEST GROUP 1: Basic Service Duration Slots', () => {
        it('generates correct number of slots for 60min service in 09:30-20:30', () => {
            // 11 hours = 11 slots of 60 min each
            const input = buildInput({
                timeline: [
                    { start: '09:30', end: '20:30', status: 'available' }
                ],
                serviceDuration: 60,
                workingHours: { start: '09:30', end: '20:30' }
            });

            const result = generateBookableSlots(input);

            // Should have 11 slots
            expect(result.length).toBe(11);

            // First slot should be 09:30-10:30
            expect(result[0].start).toBe('09:30');
            expect(result[0].end).toBe('10:30');
            expect(result[0].status).toBe('available');

            // Last slot should be 19:30-20:30
            expect(result[result.length - 1].start).toBe('19:30');
            expect(result[result.length - 1].end).toBe('20:30');
            expect(result[result.length - 1].status).toBe('available');
        });

        it('generates correct slots for 45min service with tail', () => {
            // 11 hours = 660 min / 45 = 14 full slots + 30 min tail
            const input = buildInput({
                timeline: [
                    { start: '09:30', end: '20:30', status: 'available' }
                ],
                serviceDuration: 45,
                workingHours: { start: '09:30', end: '20:30' }
            });

            const result = generateBookableSlots(input);

            // Should have 15 slots (14 available + 1 tail notAvailable)
            expect(result.length).toBe(15);

            // First slot: 09:30-10:15
            expect(result[0].start).toBe('09:30');
            expect(result[0].end).toBe('10:15');

            // Last full slot: 19:15-20:00
            expect(result[result.length - 2].start).toBe('19:15');
            expect(result[result.length - 2].end).toBe('20:00');

            // Last is tail: 20:00-20:30 (30 min < 45 min)
            const lastSlot = result[result.length - 1];
            expect(lastSlot.start).toBe('20:00');
            expect(lastSlot.end).toBe('20:30');
            expect(lastSlot.status).toBe('notAvailable');
        });
    });

    // ===== TEST GROUP 2: Busy/Appointment - ATOMIC =====
    describe('TEST GROUP 2: Busy/Appointment (ATOMIC)', () => {
        it('busy interval remains atomic - not split by service duration', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '10:00', status: 'available' },
                    { start: '10:00', end: '10:30', status: 'busy' },  // appointment
                    { start: '10:30', end: '21:00', status: 'available' }
                ],
                serviceDuration: 20,
                workingHours: { start: '09:00', end: '21:00' }
            });

            const result = generateBookableSlots(input);

            // Find the busy block - should be atomic
            const busyBlock = result.find(s => s.status === 'busy');
            expect(busyBlock).toBeDefined();
            expect(busyBlock.start).toBe('10:00');
            expect(busyBlock.end).toBe('10:30');
        });

        it('finds first available slot after busy interval', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:30', end: '10:00', status: 'available' },
                    { start: '10:00', end: '10:30', status: 'busy' },  // appointment
                    { start: '10:30', end: '21:00', status: 'available' }
                ],
                serviceDuration: 45,
                workingHours: { start: '09:30', end: '21:00' }
            });

            const result = generateBookableSlots(input);

            // With 45min service starting at 10:30: first slot is 10:30-11:15
            // (10:30 + 45 = 11:15)
            // There's no 11:00 slot with45min duration starting at 10:30

            // Find the slot after the busy interval (10:30-11:15)
            const slotAfterAppt = result.find(s => s.start === '10:30');
            expect(slotAfterAppt).toBeDefined();
            expect(slotAfterAppt.status).toBe('available');
            expect(slotAfterAppt.end).toBe('11:15');
        });

        it('multiple busy intervals each remain atomic', () => {
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

            const busyBlocks = result.filter(s => s.status === 'busy');
            expect(busyBlocks.length).toBe(2);
            expect(busyBlocks[0].start).toBe('10:00');
            expect(busyBlocks[0].end).toBe('10:30');
            expect(busyBlocks[1].start).toBe('11:00');
            expect(busyBlocks[1].end).toBe('12:00');
        });
    });

    // ===== TEST GROUP 3: Closure/Break - ATOMIC =====
    describe('TEST GROUP 3: Closure/Break (ATOMIC)', () => {
        it('closure interval remains atomic', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '11:30', status: 'available' },
                    { start: '11:30', end: '13:00', status: 'closed' },  // closure
                    { start: '13:00', end: '21:00', status: 'available' }
                ],
                serviceDuration: 20,
                workingHours: { start: '09:00', end: '21:00' }
            });

            const result = generateBookableSlots(input);

            // Find the closed block - should be atomic
            const closedBlock = result.find(s => s.status === 'closed');
            expect(closedBlock).toBeDefined();
            expect(closedBlock.start).toBe('11:30');
            expect(closedBlock.end).toBe('13:00');
        });

        it('break interval remains atomic', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '12:00', status: 'available' },
                    { start: '12:00', end: '13:00', status: 'closed' },  // break
                    { start: '13:00', end: '21:00', status: 'available' }
                ],
                serviceDuration: 45,
                workingHours: { start: '09:00', end: '21:00' }
            });

            const result = generateBookableSlots(input);

            // Find the closed block - should be atomic
            const closedBlock = result.find(s => s.status === 'closed');
            expect(closedBlock).toBeDefined();
            expect(closedBlock.start).toBe('12:00');
            expect(closedBlock.end).toBe('13:00');
        });

        it('finds first available slot after closure', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:30', end: '11:30', status: 'available' },
                    { start: '11:30', end: '13:00', status: 'closed' },
                    { start: '13:00', end: '21:00', status: 'available' }
                ],
                serviceDuration: 45,
                workingHours: { start: '09:30', end: '21:00' }
            });

            const result = generateBookableSlots(input);

            // Closure is atomic: 11:30-13:00 closed
            // Available after closure should start at 13:00
            const closedBlock = result.find(s => s.status === 'closed');
            expect(closedBlock.start).toBe('11:30');
            expect(closedBlock.end).toBe('13:00');

            // First available after closure
            const afterClosure = result.find(s => s.start === '13:00');
            expect(afterClosure).toBeDefined();
            expect(afterClosure.status).toBe('available');
        });
    });

    // ===== TEST GROUP 4: Static Slot Override =====
    describe('TEST GROUP 4: Static Slot Override', () => {
        it('returns static slot as single segment regardless of service duration', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '21:00', status: 'available' }
                ],
                serviceDuration: 30,
                workingHours: { start: '09:00', end: '21:00' },
                staticSlots: [
                    { start: '11:00', end: '12:00' }
                ]
            });

            const result = generateBookableSlots(input);

            // Find static slot
            const staticSlot = result.find(s => s.start === '11:00');
            expect(staticSlot).toBeDefined();
            expect(staticSlot.end).toBe('12:00');
            expect(staticSlot.status).toBe('available');
        });

        it('handles static slot with different service durations', () => {
            const durations = [15, 30, 45, 60];

            durations.forEach(svcDuration => {
                const input = buildInput({
                    timeline: [
                        { start: '09:00', end: '21:00', status: 'available' }
                    ],
                    serviceDuration: svcDuration,
                    workingHours: { start: '09:00', end: '21:00' },
                    staticSlots: [
                        { start: '11:00', end: '12:00' }
                    ]
                });

                const result = generateBookableSlots(input);
                const staticSlot = result.find(s => s.start === '11:00');

                expect(staticSlot).toBeDefined();
                expect(staticSlot.end).toBe('12:00');
                expect(staticSlot.status).toBe('available');
            });
        });

        it('marks static slot as busy when appointment overlaps', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '11:00', status: 'available' },
                    { start: '11:00', end: '11:30', status: 'busy' },  // appointment inside static
                    { start: '11:30', end: '12:00', status: 'busy' },  // continues
                    { start: '12:00', end: '21:00', status: 'available' }
                ],
                serviceDuration: 30,
                workingHours: { start: '09:00', end: '21:00' },
                staticSlots: [
                    { start: '11:00', end: '12:00' }
                ]
            });

            const result = generateBookableSlots(input);

            // Static slot should be marked busy
            const staticSlot = result.find(s => s.start === '11:00');
            expect(staticSlot.status).toBe('busy');
        });
    });

    // ===== TEST GROUP 5: Day End Boundary =====
    describe('TEST GROUP 5: Day End Boundary', () => {
        it('marks last slot as notAvailable when service does not fit', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '21:00', status: 'available' }
                ],
                serviceDuration: 45,
                workingHours: { start: '09:00', end: '21:00' }
            });

            const result = generateBookableSlots(input);

            // Last possible start: 20:15 (so 20:15-21:00 = 45min)
            // 20:15-21:00 should fit
            const lastSlot = result[result.length - 1];
            const lastStart = parseHHMM(lastSlot.start);
            const closeMin = parseHHMM('21:00');

            expect(lastStart + 45).toBeLessThanOrEqual(closeMin);
        });

        it('does not generate slot that exceeds closing time', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '21:00', status: 'available' }
                ],
                serviceDuration: 60,
                workingHours: { start: '09:00', end: '21:00' }
            });

            const result = generateBookableSlots(input);

            // No slot should end after 21:00
            result.forEach(slot => {
                const endMin = parseHHMM(slot.end);
                expect(endMin).toBeLessThanOrEqual(1260);
            });
        });
    });

    // ===== TEST GROUP 6: Available Segment Splitting =====
    describe('TEST GROUP 6: Available Segment Splitting', () => {
        it('available09:30-11:00 with20min duration creates 4 available slots + 1 notAvailable tail', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:30', end: '11:00', status: 'available' }
                ],
                serviceDuration: 20,
                workingHours: { start: '09:30', end: '11:00' }
            });

            const result = generateBookableSlots(input);

            // 09:30-11:00 = 90 min, 20 min slots = 4 full slots + 10 min tail
            const availableSlots = result.filter(s => s.status === 'available');
            const notAvailableTail = result.filter(s => s.status === 'notAvailable');

            expect(availableSlots.length).toBe(4);
            expect(notAvailableTail.length).toBe(1);

            // Check slot times
            expect(availableSlots[0].start).toBe('09:30');
            expect(availableSlots[0].end).toBe('09:50');
            expect(availableSlots[1].start).toBe('09:50');
            expect(availableSlots[1].end).toBe('10:10');
            expect(availableSlots[2].start).toBe('10:10');
            expect(availableSlots[2].end).toBe('10:30');
            expect(availableSlots[3].start).toBe('10:30');
            expect(availableSlots[3].end).toBe('10:50');

            // Tail: 10:50-11:00 (remaining 10 min < 20 min duration)
            expect(notAvailableTail[0].start).toBe('10:50');
            expect(notAvailableTail[0].end).toBe('11:00');
        });

        it('available segment exactly divisible by duration has no tail', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '11:00', status: 'available' }
                ],
                serviceDuration: 30,
                workingHours: { start: '09:00', end: '11:00' }
            });

            const result = generateBookableSlots(input);

            // 09:00-11:00 = 120 min, 30 min slots = 4 slots exactly
            const availableSlots = result.filter(s => s.status === 'available');
            const notAvailableTail = result.filter(s => s.status === 'notAvailable');

            expect(availableSlots.length).toBe(4);
            expect(notAvailableTail.length).toBe(0);
        });

        it('tail exactly 1 minute should be marked notAvailable', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '10:01', status: 'available' }
                ],
                serviceDuration: 30,
                workingHours: { start: '09:00', end: '10:01' }
            });

            const result = generateBookableSlots(input);

            // 09:00-10:01 = 61 min, 30 min slots = 2 slots + 1 min tail
            const availableSlots = result.filter(s => s.status === 'available');
            const notAvailableTail = result.filter(s => s.status === 'notAvailable');

            expect(availableSlots.length).toBe(2);
            expect(notAvailableTail.length).toBe(1);
            expect(notAvailableTail[0].start).toBe('10:00');
            expect(notAvailableTail[0].end).toBe('10:01');
        });
    });

    // ===== TEST GROUP 7: Complex Day =====
    describe('TEST GROUP 7: Complex Day', () => {
        it('handles full day with all constraint types', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '09:30', status: 'available' },
                    { start: '09:30', end: '10:00', status: 'busy' },    // appointment
                    { start: '10:00', end: '12:00', status: 'available' },
                    { start: '12:00', end: '13:00', status: 'closed' },    // break
                    { start: '13:00', end: '17:00', status: 'available' },
                    { start: '17:00', end: '18:00', status: 'closed' },  // closure
                    { start: '18:00', end: '21:00', status: 'available' }
                ],
                serviceDuration: 45,
                workingHours: { start: '09:00', end: '21:00' }
            });

            const result = generateBookableSlots(input);

            // Should have mixed statuses
            const availableSlots = result.filter(s => s.status === 'available');
            const busySlots = result.filter(s => s.status === 'busy');
            const closedSlots = result.filter(s => s.status === 'closed');
            const notAvailableSlots = result.filter(s => s.status === 'notAvailable');

            expect(result.length).toBeGreaterThan(0);

            // Verify atomic busy/closed
            expect(busySlots.length).toBe(1);
            expect(busySlots[0].start).toBe('09:30');
            expect(busySlots[0].end).toBe('10:00');

            expect(closedSlots.length).toBe(2);
            expect(closedSlots[0].start).toBe('12:00');
            expect(closedSlots[0].end).toBe('13:00');
            expect(closedSlots[1].start).toBe('17:00');
            expect(closedSlots[1].end).toBe('18:00');

            // Verify chronological integrity
            for (let i = 0; i < result.length - 1; i++) {
                const currentEnd = parseHHMM(result[i].end);
                const nextStart = parseHHMM(result[i + 1].start);
                expect(nextStart).toBeGreaterThanOrEqual(currentEnd);
            }
        });
    });

    // ===== TEST GROUP 8: Empty Day =====
    describe('TEST GROUP 8: Empty Day', () => {
        it('generates slots when timeline is empty (treats as all available)', () => {
            const input = buildInput({
                timeline: [],
                serviceDuration: 60,
                workingHours: { start: '09:00', end: '21:00' }
            });

            const result = generateBookableSlots(input);

            // Should generate 12 slots (09:00 to 20:00)
            expect(result.length).toBe(12);
        });

        it('returns empty when no working hours coverage', () => {
            // When timeline is empty AND working hours are invalid (21:00-21:00),
            // result should be empty
            const input = buildInput({
                timeline: [],
                serviceDuration: 60,
                workingHours: { start: '21:00', end: '21:00' }
            });

            const result = generateBookableSlots(input);

            expect(result.length).toBe(0);
        });
    });

    // ===== TEST GROUP 9: Adjacent Segments =====
    describe('TEST GROUP 9: Adjacent Segments', () => {
        it('merges adjacent same-status segments', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '10:00', status: 'available' },
                    { start: '10:00', end: '11:00', status: 'available' }
                ],
                serviceDuration: 60,
                workingHours: { start: '09:00', end: '11:00' },
                staticSlots: []
            });

            const result = generateBookableSlots(input);

            // Should produce 09:00-10:00 and 10:00-11:00
            expect(result.length).toBe(2);
            expect(result[0].start).toBe('09:00');
            expect(result[0].end).toBe('10:00');
            expect(result[1].start).toBe('10:00');
            expect(result[1].end).toBe('11:00');
        });
    });

    // ===== TEST GROUP 10: Mixed Timeline Full Day =====
    describe('TEST GROUP 10: Mixed Timeline Full Day', () => {
        it('full day with available + busy + available produces correct output', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:30', end: '11:00', status: 'available' },
                    { start: '11:00', end: '11:45', status: 'busy' },
                    { start: '11:45', end: '20:30', status: 'available' }
                ],
                serviceDuration: 20,
                workingHours: { start: '09:30', end: '20:30' }
            });

            const result = generateBookableSlots(input);

            // Find busy block
            const busyBlock = result.find(s => s.status === 'busy');
            expect(busyBlock).toBeDefined();
            expect(busyBlock.start).toBe('11:00');
            expect(busyBlock.end).toBe('11:45');

            // Find available slots before busy (4 available + 1 tail = 5 total)
            const beforeBusy = result.filter(s => s.start < '11:00');
            expect(beforeBusy.length).toBe(5);
            const availableBeforeBusy = beforeBusy.filter(s => s.status === 'available');
            expect(availableBeforeBusy.length).toBe(4);

            // Find tail after last available slot before busy
            const tailBeforeBusy = result.find(s => s.start === '10:50');
            expect(tailBeforeBusy.status).toBe('notAvailable');
            expect(tailBeforeBusy.end).toBe('11:00');
        });

        it('available + closed + available produces correct output', () => {
            const input = buildInput({
                timeline: [
                    { start: '09:00', end: '12:00', status: 'available' },
                    { start: '12:00', end: '13:00', status: 'closed' },
                    { start: '13:00', end: '17:00', status: 'available' },
                    { start: '17:00', end: '18:00', status: 'closed' },
                    { start: '18:00', end: '21:00', status: 'available' }
                ],
                serviceDuration: 60,
                workingHours: { start: '09:00', end: '21:00' }
            });

            const result = generateBookableSlots(input);

            const closedBlocks = result.filter(s => s.status === 'closed');
            expect(closedBlocks.length).toBe(2);
            expect(closedBlocks[0].start).toBe('12:00');
            expect(closedBlocks[0].end).toBe('13:00');
            expect(closedBlocks[1].start).toBe('17:00');
            expect(closedBlocks[1].end).toBe('18:00');
        });
    });
});
