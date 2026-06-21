/**
 * Real World Busy Barber Day - Test Scenarios
 *
 * Tests the atomic interval behavior with a realistic barber day timeline.
 * Same timeline tested with 5 different service durations to ensure
 * busy/closed intervals remain atomic regardless of service duration.
 */

import { describe, it, expect } from 'vitest';
import { generateBookableSlots } from '../../src/services/booking-candidate-generator.js';

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

// Common timeline for all tests - realistic busy barber day
const REAL_WORLD_TIMELINE = [
    { start: '09:30', end: '10:00', status: 'available' },
    { start: '10:00', end: '10:30', status: 'busy' },    // 30 min appointment
    { start: '10:30', end: '11:00', status: 'available' },
    { start: '11:00', end: '11:20', status: 'busy' },    // 20 min appointment
    { start: '11:20', end: '12:00', status: 'available' },
    { start: '12:00', end: '13:00', status: 'closed' },   // lunch break
    { start: '13:00', end: '13:30', status: 'available' },
    { start: '13:30', end: '14:15', status: 'busy' },     // 45 min appointment
    { start: '14:15', end: '15:00', status: 'available' },
    { start: '15:00', end: '15:30', status: 'busy' },     // 30 min appointment
    { start: '15:30', end: '16:20', status: 'available' },
    { start: '16:20', end: '16:40', status: 'busy' },     // 20 min appointment
    { start: '16:40', end: '17:30', status: 'available' },
    { start: '17:30', end: '18:00', status: 'busy' },     // 30 min appointment
    { start: '18:00', end: '19:00', status: 'available' },
    { start: '19:00', end: '19:20', status: 'busy' },     // 20 min appointment
    { start: '19:20', end: '19:30', status: 'available' },
    { start: '19:30', end: '21:00', status: 'closed' }    // evening leave
];

const WORKING_HOURS = { start: '09:30', end: '20:30' };

// Expected atomic intervals that must exist regardless of service duration
const EXPECTED_BUSY_INTERVALS = [
    { start: '10:00', end: '10:30' },
    { start: '11:00', end: '11:20' },
    { start: '13:30', end: '14:15' },
    { start: '15:00', end: '15:30' },
    { start: '16:20', end: '16:40' },
    { start: '17:30', end: '18:00' },
    { start: '19:00', end: '19:20' }
];

const EXPECTED_CLOSED_INTERVALS = [
    { start: '12:00', end: '13:00' },  // lunch break
    { start: '19:30', end: '21:00' }   // evening leave
];

describe('TEST GROUP AA: Real World Busy Barber Day', () => {

    // ===== TEST 1: serviceDuration = 15 =====
    describe('serviceDuration = 15', () => {
        it('handles realistic busy day with 15min service duration', () => {
            const input = buildInput({
                serviceDuration: 15,
                workingHours: WORKING_HOURS,
                timeline: REAL_WORLD_TIMELINE
            });

            const result = generateBookableSlots(input);

            // APPOINTMENTS MUST REMAIN ATOMIC
            EXPECTED_BUSY_INTERVALS.forEach(interval => {
                expect(result.some(s =>
                    s.start === interval.start &&
                    s.end === interval.end &&
                    s.status === 'busy'
                )).toBe(true);
            });

            // BREAK MUST REMAIN ATOMIC
            expect(result.some(s =>
                s.start === '12:00' &&
                s.end === '13:00' &&
                s.status === 'closed'
            )).toBe(true);

            // EVENING LEAVE MUST REMAIN ATOMIC
            expect(result.some(s =>
                s.start === '19:30' &&
                s.end === '21:00' &&
                s.status === 'closed'
            )).toBe(true);

            // NO OVERLAPPING OUTPUT
            for (let i = 0; i < result.length - 1; i++) {
                const currentEnd = parseHHMM(result[i].end);
                const nextStart = parseHHMM(result[i + 1].start);
                expect(nextStart).toBeGreaterThanOrEqual(currentEnd);
            }

            // CHRONOLOGICAL ORDER
            for (let i = 0; i < result.length - 1; i++) {
                expect(parseHHMM(result[i + 1].start))
                    .toBeGreaterThanOrEqual(parseHHMM(result[i].start));
            }

            // THERE MUST BE AVAILABLE SLOTS
            const availableSlots = result.filter(s => s.status === 'available');
            expect(availableSlots.length).toBeGreaterThan(0);
        });
    });

    // ===== TEST 2: serviceDuration = 20 =====
    describe('serviceDuration = 20', () => {
        it('handles realistic busy day with 20min service duration', () => {
            const input = buildInput({
                serviceDuration: 20,
                workingHours: WORKING_HOURS,
                timeline: REAL_WORLD_TIMELINE
            });

            const result = generateBookableSlots(input);

            // APPOINTMENTS MUST REMAIN ATOMIC
            EXPECTED_BUSY_INTERVALS.forEach(interval => {
                expect(result.some(s =>
                    s.start === interval.start &&
                    s.end === interval.end &&
                    s.status === 'busy'
                )).toBe(true);
            });

            // BREAK MUST REMAIN ATOMIC
            expect(result.some(s =>
                s.start === '12:00' &&
                s.end === '13:00' &&
                s.status === 'closed'
            )).toBe(true);

            // EVENING LEAVE MUST REMAIN ATOMIC
            expect(result.some(s =>
                s.start === '19:30' &&
                s.end === '21:00' &&
                s.status === 'closed'
            )).toBe(true);

            // NO OVERLAPPING OUTPUT
            for (let i = 0; i < result.length - 1; i++) {
                const currentEnd = parseHHMM(result[i].end);
                const nextStart = parseHHMM(result[i + 1].start);
                expect(nextStart).toBeGreaterThanOrEqual(currentEnd);
            }

            // CHRONOLOGICAL ORDER
            for (let i = 0; i < result.length - 1; i++) {
                expect(parseHHMM(result[i + 1].start))
                    .toBeGreaterThanOrEqual(parseHHMM(result[i].start));
            }

            // THERE MUST BE AVAILABLE SLOTS
            const availableSlots = result.filter(s => s.status === 'available');
            expect(availableSlots.length).toBeGreaterThan(0);
        });
    });

    // ===== TEST 3: serviceDuration = 30 =====
    describe('serviceDuration = 30', () => {
        it('handles realistic busy day with 30min service duration', () => {
            const input = buildInput({
                serviceDuration: 30,
                workingHours: WORKING_HOURS,
                timeline: REAL_WORLD_TIMELINE
            });

            const result = generateBookableSlots(input);

            // APPOINTMENTS MUST REMAIN ATOMIC
            EXPECTED_BUSY_INTERVALS.forEach(interval => {
                expect(result.some(s =>
                    s.start === interval.start &&
                    s.end === interval.end &&
                    s.status === 'busy'
                )).toBe(true);
            });

            // BREAK MUST REMAIN ATOMIC
            expect(result.some(s =>
                s.start === '12:00' &&
                s.end === '13:00' &&
                s.status === 'closed'
            )).toBe(true);

            // EVENING LEAVE MUST REMAIN ATOMIC
            expect(result.some(s =>
                s.start === '19:30' &&
                s.end === '21:00' &&
                s.status === 'closed'
            )).toBe(true);

            // NO OVERLAPPING OUTPUT
            for (let i = 0; i < result.length - 1; i++) {
                const currentEnd = parseHHMM(result[i].end);
                const nextStart = parseHHMM(result[i + 1].start);
                expect(nextStart).toBeGreaterThanOrEqual(currentEnd);
            }

            // CHRONOLOGICAL ORDER
            for (let i = 0; i < result.length - 1; i++) {
                expect(parseHHMM(result[i + 1].start))
                    .toBeGreaterThanOrEqual(parseHHMM(result[i].start));
            }

            // THERE MUST BE AVAILABLE SLOTS
            const availableSlots = result.filter(s => s.status === 'available');
            expect(availableSlots.length).toBeGreaterThan(0);
        });
    });

    // ===== TEST 4: serviceDuration = 45 =====
    describe('serviceDuration = 45', () => {
        it('handles realistic busy day with 45min service duration', () => {
            const input = buildInput({
                serviceDuration: 45,
                workingHours: WORKING_HOURS,
                timeline: REAL_WORLD_TIMELINE
            });

            const result = generateBookableSlots(input);

            // APPOINTMENTS MUST REMAIN ATOMIC
            EXPECTED_BUSY_INTERVALS.forEach(interval => {
                expect(result.some(s =>
                    s.start === interval.start &&
                    s.end === interval.end &&
                    s.status === 'busy'
                )).toBe(true);
            });

            // BREAK MUST REMAIN ATOMIC
            expect(result.some(s =>
                s.start === '12:00' &&
                s.end === '13:00' &&
                s.status === 'closed'
            )).toBe(true);

            // EVENING LEAVE MUST REMAIN ATOMIC
            expect(result.some(s =>
                s.start === '19:30' &&
                s.end === '21:00' &&
                s.status === 'closed'
            )).toBe(true);

            // NO OVERLAPPING OUTPUT
            for (let i = 0; i < result.length - 1; i++) {
                const currentEnd = parseHHMM(result[i].end);
                const nextStart = parseHHMM(result[i + 1].start);
                expect(nextStart).toBeGreaterThanOrEqual(currentEnd);
            }

            // CHRONOLOGICAL ORDER
            for (let i = 0; i < result.length - 1; i++) {
                expect(parseHHMM(result[i + 1].start))
                    .toBeGreaterThanOrEqual(parseHHMM(result[i].start));
            }

            // THERE MUST BE AVAILABLE SLOTS
            const availableSlots = result.filter(s => s.status === 'available');
            expect(availableSlots.length).toBeGreaterThan(0);
        });
    });

    // ===== TEST 5: serviceDuration = 60 =====
    describe('serviceDuration = 60', () => {
        it('handles realistic busy day with 60min service duration', () => {
            const input = buildInput({
                serviceDuration: 60,
                workingHours: WORKING_HOURS,
                timeline: REAL_WORLD_TIMELINE
            });

            const result = generateBookableSlots(input);

            // APPOINTMENTS MUST REMAIN ATOMIC
            EXPECTED_BUSY_INTERVALS.forEach(interval => {
                expect(result.some(s =>
                    s.start === interval.start &&
                    s.end === interval.end &&
                    s.status === 'busy'
                )).toBe(true);
            });

            // BREAK MUST REMAIN ATOMIC
            expect(result.some(s =>
                s.start === '12:00' &&
                s.end === '13:00' &&
                s.status === 'closed'
            )).toBe(true);

            // EVENING LEAVE MUST REMAIN ATOMIC
            expect(result.some(s =>
                s.start === '19:30' &&
                s.end === '21:00' &&
                s.status === 'closed'
            )).toBe(true);

            // NO OVERLAPPING OUTPUT
            for (let i = 0; i < result.length - 1; i++) {
                const currentEnd = parseHHMM(result[i].end);
                const nextStart = parseHHMM(result[i + 1].start);
                expect(nextStart).toBeGreaterThanOrEqual(currentEnd);
            }

            // CHRONOLOGICAL ORDER
            for (let i = 0; i < result.length - 1; i++) {
                expect(parseHHMM(result[i + 1].start))
                    .toBeGreaterThanOrEqual(parseHHMM(result[i].start));
            }

            // THERE MUST BE AVAILABLE SLOTS
            const availableSlots = result.filter(s => s.status === 'available');
            expect(availableSlots.length).toBeGreaterThan(0);
        });
    });

});
