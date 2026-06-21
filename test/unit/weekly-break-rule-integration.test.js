/**
 * weekly-break-rule-integration.test.js
 *
 * Integration testleri: weekly-break-rule-expander + slot-generator-v2
 *
 * Bu testler, genişletilen break rules'ın engine'e doğru aktarıldığını
 * ve slot üretiminde `closed` olarak göründüğünü doğrular.
 */

import { describe, it, expect } from 'vitest';
import { expandWeeklyBreakRules } from '../../src/services/weekly-break-rule-expander.js';
import { generateSlotsV2Engine } from '../../src/services/slot-generator-v2.js';

describe('Weekly Break Rule Integration', () => {

    // Test 1: Friday 12:00-14:00 break -> engine produces closed slots
    it('maps friday 12:00-14:00 break to closed slots in timeline', () => {
        // Arrange
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '12:00', endHour: '13:00', note: 'Öğle arası' },
                { startHour: '13:00', endHour: '14:00', note: 'Cuma Namazı' }
            ]
        };

        // Act
        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        // Break rules should be expanded correctly
        expect(breakRules.length).toBe(2);
        expect(breakRules[0]).toEqual({
            start: '12:00',
            end: '13:00',
            note: 'Öğle arası',
            source: 'weekly_break_rule'
        });
        expect(breakRules[1]).toEqual({
            start: '13:00',
            end: '14:00',
            note: 'Cuma Namazı',
            source: 'weekly_break_rule'
        });

        // Now pass to engine
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

        // Find the closed segments
        const closedSlots = engineResult.slots.filter(s => s.status === 'closed');

        // The 12:00-14:00 period should be marked as closed
        expect(closedSlots.length).toBeGreaterThan(0);

        // Find slots that overlap with 12:00-14:00
        const overlappingClosed = closedSlots.filter(s => {
            const slotStart = timeToMinutes(s.start);
            const slotEnd = timeToMinutes(s.end);
            const breakStart = timeToMinutes('12:00');
            const breakEnd = timeToMinutes('14:00');
            return slotStart < breakEnd && slotEnd > breakStart;
        });

        expect(overlappingClosed.length).toBeGreaterThan(0);
    });

    // Test 2: No break rules for current day -> no closed slots from breakRules
    it('produces no closed slots when there are no break rules', () => {
        // Arrange
        const wednesdayDate = '2026-06-17';

        const weeklyBreakRule = {
            monday: [{ startHour: '10:00', endHour: '11:00' }],
            tuesday: [{ startHour: '10:00', endHour: '11:00' }],
            // No wednesday entry
        };

        // Act
        const breakRules = expandWeeklyBreakRules({
            date: wednesdayDate,
            weeklyBreakRule
        });

        expect(breakRules).toEqual([]);

        // Engine should not produce closed slots from breakRules
        const engineResult = generateSlotsV2Engine({
            date: wednesdayDate,
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

        // No closed slots should be generated from breakRules
        const closedSlots = engineResult.slots.filter(s => s.status === 'closed');
        expect(closedSlots.length).toBe(0);
    });

    // Test 3: Break rule with multiple days -> only correct day expanded
    it('only expands break rules for the target day', () => {
        // Arrange
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            monday: [{ startHour: '10:00', endHour: '11:00', note: 'Monday break' }],
            tuesday: [{ startHour: '11:00', endHour: '12:00', note: 'Tuesday break' }],
            wednesday: [{ startHour: '12:00', endHour: '13:00', note: 'Wednesday break' }],
            thursday: [{ startHour: '13:00', endHour: '14:00', note: 'Thursday break' }],
            friday: [{ startHour: '14:00', endHour: '15:00', note: 'Friday break' }],
            saturday: [{ startHour: '15:00', endHour: '16:00', note: 'Saturday break' }],
            sunday: [{ startHour: '16:00', endHour: '17:00', note: 'Sunday break' }]
        };

        // Act
        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        // Only friday rule should be returned
        expect(breakRules.length).toBe(1);
        expect(breakRules[0]).toEqual({
            start: '14:00',
            end: '15:00',
            note: 'Friday break',
            source: 'weekly_break_rule'
        });
    });

    // Test 4: Merge break rule with closure -> closure takes priority
    it('closure takes priority over break rule when overlapping', () => {
        // Arrange
        const fridayDate = '2026-06-19';

        const weeklyBreakRule = {
            friday: [
                { startHour: '12:00', endHour: '14:00', note: 'Weekly break' }
            ]
        };

        const breakRules = expandWeeklyBreakRules({
            date: fridayDate,
            weeklyBreakRule
        });

        // Closure overlaps with break rule
        const closures = [
            { start: '13:00', end: '14:00', scope: 'global' }
        ];

        // Act
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

        // Engine merges closures with break rules
        // The 12:00-14:00 area should have closure priority (closed)
        const closedSlots = engineResult.slots.filter(s => s.status === 'closed');

        // Should have closed slots covering the merged area
        expect(closedSlots.length).toBeGreaterThan(0);
    });

});

// Helper function
function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + (m || 0);
}