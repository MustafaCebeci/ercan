/**
 * Booking Candidate Generator
 *
 * Generates bookable slot candidates from timeline.
 * Timeline Engine produces segments, this generator produces
 * actual reservation start points.
 *
 * Input:
 * {
 *   timeline: [{ start, end, status }, ...],  // from V2 Timeline Engine
 *   serviceDuration: 60,                      // in minutes
 *   workingHours: { start: '09:00', end: '21:00' },
 *   staticSlots: [{ start: '11:00', end: '12:00' }, ...]
 * }
 *
 * Output:
 * [{ start, end, status }, ...]
 *
 * Rules:
 * - A slot is available only if: start + serviceDuration does not overlap any blocker
 * - Static slots are kept as single segments (override service duration)
 */

function parseHHMM(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
}

function minutesToHHMM(mins) {
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/**
 * Generate bookable slot candidates from timeline
 * @param {Object} input
 * @param {Array} input.timeline - Timeline segments from V2 Engine
 * @param {number} input.serviceDuration - Service duration in minutes
 * @param {Object} input.workingHours - { start: 'HH:MM', end: 'HH:MM' }
 * @param {Array} input.staticSlots - Static slots [{start, end}, ...]
 * @returns {Array} Bookable slots [{start, end, status}, ...]
 *
 * Rules:
 * - busy/closed segments are kept ATOMIC (not split by service duration)
 * - available segments are split by service duration
 * - short tails (remaining time < serviceDuration) are marked notAvailable
 * - static slots override service duration behavior
 * - empty timeline treated as all available within working hours
 */
function generateBookableSlots(input) {
    const {
        timeline = [],
        serviceDuration = 60,
        workingHours = { start: '09:00', end: '21:00' },
        staticSlots = []
    } = input;

    const openMin = parseHHMM(workingHours.start);
    const closeMin = parseHHMM(workingHours.end);
    const duration = serviceDuration || 60;

    // Parse static slots to minutes
    const staticSlotsMins = staticSlots.map(ss => ({
        start: parseHHMM(ss.start),
        end: parseHHMM(ss.end)
    })).filter(ss => ss.end > ss.start);

    // Check if a time range is within a static slot
    function isInStaticSlot(startMin, endMin) {
        return staticSlotsMins.some(ss =>
            startMin >= ss.start && endMin <= ss.end
        );
    }

    // Check if a static slot overlaps with any busy/closed segment
    function staticSlotBlocked(ss) {
        return timeline.some(seg => {
            if (seg.status === 'available') return false;
            const segStart = parseHHMM(seg.start);
            const segEnd = parseHHMM(seg.end);
            return ss.start < segEnd && ss.end > segStart;
        });
    }

    const result = [];

    // If timeline is empty, treat as all available within working hours
    const effectiveTimeline = timeline.length > 0
        ? timeline
        : [{ start: workingHours.start, end: workingHours.end, status: 'available' }];

    // Process each timeline segment
    for (const seg of effectiveTimeline) {
        const segStart = parseHHMM(seg.start);
        const segEnd = parseHHMM(seg.end);

        // ATOMIC: busy or closed segments are kept intact
        if (seg.status === 'busy' || seg.status === 'closed') {
            result.push({
                start: seg.start,
                end: seg.end,
                status: seg.status
            });
            continue;
        }

        // AVAILABLE segment: split by service duration
        if (seg.status === 'available') {
            let time = segStart;

            while (time + duration <= segEnd) {
                const candEnd = time + duration;

                // Skip if this slot is covered by a static slot (will be handled separately)
                if (!isInStaticSlot(time, candEnd)) {
                    result.push({
                        start: minutesToHHMM(time),
                        end: minutesToHHMM(candEnd),
                        status: 'available'
                    });
                }

                time += duration;
            }

            // Tail: remaining time < serviceDuration is notAvailable
            if (time < segEnd) {
                result.push({
                    start: minutesToHHMM(time),
                    end: seg.end,
                    status: 'notAvailable'
                });
            }
        }
    }

    // Static slots: add as single segments
    for (const ss of staticSlotsMins) {
        // Check if this static slot is within working hours
        if (ss.end <= openMin || ss.start >= closeMin) continue;

        const startMin = Math.max(ss.start, openMin);
        const endMin = Math.min(ss.end, closeMin);

        // Check if overlaps with busy/closed
        const blocked = staticSlotBlocked(ss);

        result.push({
            start: minutesToHHMM(startMin),
            end: minutesToHHMM(endMin),
            status: blocked ? 'busy' : 'available'
        });
    }

    // Sort by start time
    result.sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start));

    return result;
}

module.exports = { generateBookableSlots };