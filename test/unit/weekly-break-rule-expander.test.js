/**
 * weekly-break-rule-expander.test.js
 *
 * Unit testleri: weekly-break-rule-expander.js
 */

import { describe, it, expect } from 'vitest';
import { expandWeeklyBreakRules } from '../../src/services/weekly-break-rule-expander.js';

describe('Weekly Break Rule Expander', () => {

    // Test 1: Friday -> returns friday rules
    it('returns friday rules for 2026-06-19', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: {
                friday: [
                    { startHour: '12:00', endHour: '13:00', note: 'Öğle arası' }
                ]
            }
        });
        expect(result).toEqual([
            { start: '12:00', end: '13:00', note: 'Öğle arası', source: 'weekly_break_rule' }
        ]);
    });

    // Test 2: Wednesday -> returns wednesday rules
    it('returns wednesday rules for 2026-06-17', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-17',
            weeklyBreakRule: {
                wednesday: [
                    { startHour: '14:00', endHour: '15:00', note: 'Toplantı' }
                ]
            }
        });
        expect(result).toEqual([
            { start: '14:00', end: '15:00', note: 'Toplantı', source: 'weekly_break_rule' }
        ]);
    });

    // Test 3: Sunday -> no rules -> empty array
    it('returns empty array for sunday when no rules', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-21',
            weeklyBreakRule: {}
        });
        expect(result).toEqual([]);
    });

    // Test 4: Invalid startHour (null) -> ignored
    it('ignores break with null startHour', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: {
                friday: [
                    { startHour: null, endHour: '13:00' }
                ]
            }
        });
        expect(result).toEqual([]);
    });

    // Test 5: Invalid endHour (null) -> ignored
    it('ignores break with null endHour', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: {
                friday: [
                    { startHour: '12:00', endHour: null }
                ]
            }
        });
        expect(result).toEqual([]);
    });

    // Test 6: End before start -> ignored
    it('ignores break where endHour < startHour', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: {
                friday: [
                    { startHour: '14:00', endHour: '12:00' }
                ]
            }
        });
        expect(result).toEqual([]);
    });

    // Test 7: End equals start -> ignored (endMin <= startMin)
    it('ignores break where endHour === startHour', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: {
                friday: [
                    { startHour: '12:00', endHour: '12:00' }
                ]
            }
        });
        expect(result).toEqual([]);
    });

    // Test 8: Multiple Friday Rules -> all returned
    it('returns all friday rules', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: {
                friday: [
                    { startHour: '12:00', endHour: '13:00', note: 'Öğle arası' },
                    { startHour: '13:00', endHour: '14:00', note: 'Cuma Namazı' }
                ]
            }
        });
        expect(result.length).toBe(2);
        expect(result[0].start).toBe('12:00');
        expect(result[1].start).toBe('13:00');
    });

    // Test 9: No weeklyBreakRule -> empty array
    it('returns empty array when weeklyBreakRule is null', () => {
        const result = expandWeeklyBreakRules({ date: '2026-06-19', weeklyBreakRule: null });
        expect(result).toEqual([]);
    });

    // Test 10: Invalid date format -> empty array
    it('returns empty array for invalid date', () => {
        const result = expandWeeklyBreakRules({
            date: 'invalid-date',
            weeklyBreakRule: { friday: [{ startHour: '12:00', endHour: '13:00' }] }
        });
        expect(result).toEqual([]);
    });

    // Test 11: Monday rules for monday date
    it('returns monday rules for 2026-06-15', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-15',
            weeklyBreakRule: {
                monday: [
                    { startHour: '10:00', endHour: '11:00', note: 'Sabah molası' }
                ]
            }
        });
        expect(result).toEqual([
            { start: '10:00', end: '11:00', note: 'Sabah molası', source: 'weekly_break_rule' }
        ]);
    });

    // Test 12: No note -> returns null for note field
    it('returns null for note when not provided', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: {
                friday: [
                    { startHour: '12:00', endHour: '13:00' }
                ]
            }
        });
        expect(result).toEqual([
            { start: '12:00', end: '13:00', note: null, source: 'weekly_break_rule' }
        ]);
    });

    // Test 13: Empty dayBreaks array -> empty result
    it('returns empty array when dayBreaks is empty array', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: {
                friday: []
            }
        });
        expect(result).toEqual([]);
    });

    // Test 14: Invalid HH:MM format (25:00) -> ignored
    it('ignores break with invalid HH:MM format', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: {
                friday: [
                    { startHour: '25:00', endHour: '26:00' }
                ]
            }
        });
        expect(result).toEqual([]);
    });

    // Test 15: Saturday rules for saturday date
    it('returns saturday rules for 2026-06-20', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-20',
            weeklyBreakRule: {
                saturday: [
                    { startHour: '09:00', endHour: '10:00', note: 'Sabah antrenman' }
                ]
            }
        });
        expect(result).toEqual([
            { start: '09:00', end: '10:00', note: 'Sabah antrenman', source: 'weekly_break_rule' }
        ]);
    });

    // Test 16: Thursday rules for thursday date
    it('returns thursday rules for 2026-06-18', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-18',
            weeklyBreakRule: {
                thursday: [
                    { startHour: '16:00', endHour: '17:00', note: 'Yüzme' }
                ]
            }
        });
        expect(result).toEqual([
            { start: '16:00', end: '17:00', note: 'Yüzme', source: 'weekly_break_rule' }
        ]);
    });

    // Test 17: Tuesday rules for tuesday date
    it('returns tuesday rules for 2026-06-16', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-16',
            weeklyBreakRule: {
                tuesday: [
                    { startHour: '11:00', endHour: '12:00', note: 'Kahve molası' }
                ]
            }
        });
        expect(result).toEqual([
            { start: '11:00', end: '12:00', note: 'Kahve molası', source: 'weekly_break_rule' }
        ]);
    });

    // Test 18: Mixed valid and invalid breaks -> only valid returned
    it('filters out invalid breaks and returns only valid ones', () => {
        const result = expandWeeklyBreakRules({
            date: '2026-06-19',
            weeklyBreakRule: {
                friday: [
                    { startHour: '12:00', endHour: '13:00', note: 'Geçerli' },
                    { startHour: null, endHour: '14:00' },       // invalid: null startHour
                    { startHour: '15:00', endHour: '14:00' },   // invalid: end < start
                    { startHour: '16:00', endHour: '17:00', note: 'Ayrıca geçerli' }
                ]
            }
        });
        expect(result.length).toBe(2);
        expect(result[0].start).toBe('12:00');
        expect(result[1].start).toBe('16:00');
    });

});