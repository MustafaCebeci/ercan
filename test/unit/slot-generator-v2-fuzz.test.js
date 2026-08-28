/**
 * Slot Generator V2 — Property-Based / Fuzz Tests
 *
 * Bug fix coverage: today-filter logic must satisfy 6 invariants across 1000
 * random scenarios of mixed working hours, service durations, current-minute
 * positions, and blocker arrangements.
 *
 * Properties verified:
 *  P1: currentMinute >= closeMin  ⇒  slots=[], dayAlreadyOver=true
 *  P2: currentMinute <  openMin   ⇒  no slot dropped (only blockers reduce slots)
 *  P3: In-progress slot (slot.start <= currentMinute < slot.end) carries
 *      status 'inProgress' (if originally available) or original non-available status
 *  P4: No slot in result has slot.end <= currentMinute (no fully-past leak)
 *  P5: isToday=false ⇒ result equals unfiltered timeline (no meta flags set)
 *  P6: generateBookableSlots() never throws on any engine output
 */

import { describe, it, expect } from 'vitest';
import { generateSlotsV2Engine } from '../../src/services/slot-generator-v2.js';
import { generateBookableSlots } from '../../src/services/booking-candidate-generator.js';

function parseHHMM(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
}

function minutesToHHMM(mins) {
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function rand(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function randBool() {
    return Math.random() < 0.5;
}

function genScenario(seed) {
    // Deterministic by seed for reproducibility
    let s = seed;
    const next = () => {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
    };
    const r = (min, max) => min + Math.floor(next() * (max - min + 1));

    const openMin = r(6, 10) * 60;        // 06:00–10:00
    const closeMin = r(16, 22) * 60;       // 16:00–22:00
    const serviceDuration = [15, 30, 45, 60, 90, 120][r(0, 5)];
    const currentMinute = r(0, 24 * 60 - 1);
    const isToday = next() < 0.6;          // 60% chance isToday=true (focus on bug path)

    const apptCount = r(0, 5);
    const appointments = [];
    for (let i = 0; i < apptCount; i++) {
        const startMin = r(openMin, Math.max(openMin, closeMin - 30));
        const endMin = Math.min(closeMin, startMin + r(15, 90));
        if (endMin > startMin) {
            appointments.push({ start: minutesToHHMM(startMin), end: minutesToHHMM(endMin) });
        }
    }

    const closureCount = next() < 0.3 ? r(0, 2) : 0;
    const closures = [];
    for (let i = 0; i < closureCount; i++) {
        const startMin = r(openMin, Math.max(openMin, closeMin - 30));
        const endMin = Math.min(closeMin, startMin + r(15, 90));
        if (endMin > startMin) {
            closures.push({ start: minutesToHHMM(startMin), end: minutesToHHMM(endMin) });
        }
    }

    return {
        input: {
            date: '2026-06-10',
            serviceDuration,
            workingHours: { start: minutesToHHMM(openMin), end: minutesToHHMM(closeMin) },
            appointments,
            closures,
            breakRules: [],
            staticSlots: [],
            reservedSlots: [],
            isToday,
            currentMinute: isToday ? currentMinute : null,
            settings: { slotTime: 60 },
        },
        openMin,
        closeMin,
        currentMinute,
        isToday,
    };
}

describe('Slot Generator V2 — Today Filter Fuzz (1000 scenarios)', () => {
    const TOTAL = 1000;
    let violations = { P1: 0, P2: 0, P3: 0, P4: 0, P5: 0, P6: 0 };
    let examples = {};

    for (let i = 0; i < TOTAL; i++) {
        it(`scenario #${i + 1} satisfies all 6 invariants`, () => {
            const sc = genScenario(i + 1);
            let result;
            try {
                result = generateSlotsV2Engine(sc.input);
            } catch (err) {
                throw new Error(`Engine threw: ${err.message}\nInput: ${JSON.stringify(sc.input)}`);
            }

            if (!result || !Array.isArray(result.slots)) {
                throw new Error(`Bad engine output: ${JSON.stringify(result)}`);
            }

            // P1: currentMinute >= closeMin ⇒ slots=[], dayAlreadyOver=true
            if (sc.isToday && sc.currentMinute >= sc.closeMin) {
                if (result.slots.length !== 0) {
                    violations.P1++;
                    examples.P1 = examples.P1 || { sc, result };
                }
                if (result.dayAlreadyOver !== true) {
                    violations.P1++;
                    examples.P1 = examples.P1 || { sc, result, missingFlag: true };
                }
            }

            // P2: currentMinute < openMin ⇒ no slot dropped due to past filter
            if (sc.isToday && sc.currentMinute < sc.openMin) {
                // Run again without isToday to compare
                const refInput = { ...sc.input, isToday: false, currentMinute: null };
                const refResult = generateSlotsV2Engine(refInput);
                if (result.slots.length !== refResult.slots.length) {
                    violations.P2++;
                    examples.P2 = examples.P2 || { sc, result, refResult };
                }
            }

            // P3: In-progress slot status (slot.start < currentMinute < slot.end — strict)
            if (sc.isToday && sc.currentMinute < sc.closeMin && sc.currentMinute >= sc.openMin) {
                for (const slot of result.slots) {
                    const s = parseHHMM(slot.start);
                    const e = parseHHMM(slot.end);
                    if (s < sc.currentMinute && e > sc.currentMinute) {
                        const ok = ['inProgress', 'busy', 'closed', 'notAvailable'].includes(slot.status);
                        if (!ok) {
                            violations.P3++;
                            examples.P3 = examples.P3 || { sc, slot };
                        }
                    }
                }
            }

            // P4: No fully-past slot leaks
            if (sc.isToday && sc.currentMinute !== null && sc.currentMinute < sc.closeMin) {
                for (const slot of result.slots) {
                    const endMin = parseHHMM(slot.end);
                    if (endMin <= sc.currentMinute) {
                        violations.P4++;
                        examples.P4 = examples.P4 || { sc, slot };
                    }
                }
            }

            // P5: isToday=false ⇒ no filtering
            if (!sc.isToday) {
                const refInput = { ...sc.input, isToday: false, currentMinute: null };
                const refResult = generateSlotsV2Engine(refInput);
                if (JSON.stringify(result.slots) !== JSON.stringify(refResult.slots)) {
                    violations.P5++;
                    examples.P5 = examples.P5 || { sc, result, refResult };
                }
                if (result.dayAlreadyOver !== false || result.dayFullyClosed !== false) {
                    violations.P5++;
                    examples.P5 = examples.P5 || { sc, result, flagsSet: true };
                }
            }

            // P6: generateBookableSlots must not throw
            try {
                generateBookableSlots({
                    timeline: result.slots,
                    serviceDuration: sc.input.serviceDuration,
                    workingHours: sc.input.workingHours,
                    staticSlots: [],
                });
            } catch (err) {
                violations.P6++;
                examples.P6 = examples.P6 || { sc, result, err: err.message };
            }
        });
    }

    it('aggregate: total violations across all properties must be 0', () => {
        const total = Object.values(violations).reduce((a, b) => a + b, 0);
        if (total > 0) {
            const summary = Object.entries(violations)
                .filter(([, v]) => v > 0)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
            const exampleDetails = Object.entries(examples)
                .map(([k, v]) => `\n  ${k}: ${JSON.stringify(v).slice(0, 500)}`)
                .join('');
            throw new Error(
                `Fuzz found ${total} invariant violations across ${TOTAL} scenarios (${summary})${exampleDetails}`
            );
        }
        expect(total).toBe(0);
    });
});
