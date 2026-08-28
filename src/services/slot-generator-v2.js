/**
 * Slot Generator V2 Engine
 * Pure function - no dependencies on req, res, jwt, mysql, or pool
 *
 * Input format:
 * {
 *   date: '2026-06-10',
 *   serviceDuration: 45,
 *   workingHours: { start: '09:00', end: '21:00' },
 *   appointments: [{ start: '09:00', end: '10:00' }, ...],
 *   closures: [{ start: '09:00', end: '10:00', scope: 'global' }, ...],
 *   breakRules: [{ start: '12:00', end: '13:00' }, ...],
 *   staticSlots: [{ start: '11:00', end: '12:00' }, ...],
 *   isToday: false,
 *   currentMinute: 540, // for today filtering, null otherwise
 * }
 *
 * Output format:
 * {
 *   slots: [{ start: '09:00', end: '10:00', status: 'available' }, ...],
 *   settings: { open_time, close_time, slot_time, duration }
 * }
 */

/**
 * Parse HH:MM or HH:MM:SS to minutes
 * @param {string} hhmm
 * @returns {number} minutes
 */
function parseHHMM(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
}

/**
 * Convert minutes to HH:MM format
 * @param {number} mins
 * @returns {string}
 */
function minutesToHHMM(mins) {
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/**
 * Generate slots using Timeline Segmentation algorithm
 *
 * @param {Object} input - Engine input
 * @param {string} input.date - Target date YYYY-MM-DD
 * @param {number} input.serviceDuration - Service duration in minutes
 * @param {Object} input.workingHours - { start: 'HH:MM', end: 'HH:MM' }
 * @param {Array} input.appointments - [{ start: 'HH:MM', end: 'HH:MM' }]
 * @param {Array} input.closures - [{ start: 'HH:MM', end: 'HH:MM', scope: 'global'|'provider' }]
 * @param {Array} input.breakRules - [{ start: 'HH:MM', end: 'HH:MM' }]
 * @param {Array} input.staticSlots - [{ start: 'HH:MM', end: 'HH:MM' }]
 * @param {boolean} input.isToday - Is target date today
 * @param {number|null} input.currentMinute - Current minute of day (for past filtering)
 * @param {Object} input.settings - Original settings for response
 * @returns {Object} { slots, settings }
 */
function generateSlotsV2Engine(input) {
    const {
        date,
        serviceDuration = 60,
        workingHours = { start: '09:00', end: '22:00' },
        appointments = [],
        closures = [],
        breakRules = [],
        staticSlots = [],
        reservedSlots = [],
        isToday = false,
        currentMinute = null,
        settings = {},
    } = input;

    const startHour = workingHours.start || '09:00';
    const endHour = workingHours.end || '22:00';
    const duration = serviceDuration || 60;

    // ====== STEP 1: Collect All Blockers ======
    const busyIntervals = []; // {start, end, type}

    // Add appointments
    for (const appt of appointments) {
        const startMin = parseHHMM(appt.start);
        const endMin = parseHHMM(appt.end);
        if (endMin > startMin) {
            busyIntervals.push({
                start: startMin,
                end: endMin,
                type: 'appointment'
            });
        }
    }

    // Add closures
    for (const closure of closures) {
        let startMin, endMin;

        if (closure.is_all_day == 1) {
            // closure.start = "2026-08-17T00:00", closure.end = "2026-08-24T23:59"
            const closureStartDate = String(closure.start).split('T')[0];
            const closureEndDate = String(closure.end).split('T')[0];

            // Skip if targetDate is not in range
            if (date < closureStartDate || date > closureEndDate) {
                continue;
            }

            // targetDate is in range → full day closure → use workingHours
            startMin = parseHHMM(startHour);
            endMin = parseHHMM(endHour);
        } else {
            startMin = parseHHMM(closure.start);
            endMin = parseHHMM(closure.end);
        }

        if (endMin > startMin) {
            busyIntervals.push({
                start: startMin,
                end: endMin,
                type: 'closure'
            });
        }
    }

    // Add break rules
    for (const brk of breakRules) {
        const startMin = parseHHMM(brk.start);
        const endMin = parseHHMM(brk.end);
        if (endMin > startMin) {
            busyIntervals.push({
                start: startMin,
                end: endMin,
                type: 'break'
            });
        }
    }

    // Add reserved slots
    for (const rs of reservedSlots) {
        const startMin = parseHHMM(rs.start);
        const endMin = parseHHMM(rs.end);
        if (endMin > startMin) {
            busyIntervals.push({
                start: startMin,
                end: endMin,
                type: 'reserved'
            });
        }
    }

    // ====== STEP 2: Merge Overlapping Intervals ======
    // Sort by start time
    const sorted = [...busyIntervals].sort((a, b) => a.start - b.start);

    // Merge overlapping intervals
    const merged = [];
    for (const iv of sorted) {
        if (merged.length === 0 || merged[merged.length - 1].end <= iv.start) {
            merged.push({ ...iv });
        } else {
            // Overlapping - extend the previous interval
            merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, iv.end);
            // Keep the more restrictive type (closure > reserved > break > appointment)
            const typePriority = { closure: 4, reserved: 3, break: 2, appointment: 1 };
            if ((typePriority[iv.type] || 0) > (typePriority[merged[merged.length - 1].type] || 0)) {
                merged[merged.length - 1].type = iv.type;
            }
        }
    }

    // ====== STEP 3: Parse Static Slots to minutes ======
    const staticSlotsMins = staticSlots.map(ss => ({
        start: parseHHMM(ss.start),
        end: parseHHMM(ss.end)
    })).filter(ss => ss.end > ss.start);

    // ====== STEP 4: Generate Timeline Points ======
    const openMin = parseHHMM(startHour);
    const closeMin = parseHHMM(endHour);

    // Collect all critical points
    const points = new Set([openMin, closeMin]);
    for (const iv of merged) {
        points.add(iv.start);
        points.add(iv.end);
    }
    for (const ss of staticSlotsMins) {
        points.add(ss.start);
        points.add(ss.end);
    }
    const sortedPoints = Array.from(points).sort((a, b) => a - b);

    // ====== STEP 5 & 6: Create Segments and Evaluate ======
    const slots = [];
    const step = 5; // 5-minute step for timeline

    for (let i = 0; i < sortedPoints.length - 1; i++) {
        const segStart = sortedPoints[i];
        const segEnd = sortedPoints[i + 1];

        // Skip segments outside working hours
        if (segEnd <= openMin || segStart >= closeMin) continue;

        // Clip to working hours
        const actualStart = Math.max(segStart, openMin);
        const actualEnd = Math.min(segEnd, closeMin);
        if (actualEnd <= actualStart) continue;

        // Check if this segment is a static slot
        let isStaticSlot = false;
        for (const ss of staticSlotsMins) {
            if (actualStart >= ss.start && actualEnd <= ss.end) {
                isStaticSlot = true;
                break;
            }
        }

        // Determine status
        let status = 'available';
        let segmentType = null;

        // Check if segment overlaps with any merged interval
        for (const iv of merged) {
            if (actualStart < iv.end && iv.start < actualEnd) {
                segmentType = iv.type;
                break;
            }
        }

        if (isStaticSlot) {
            // Static slots are always available (unless overlapped by appointment/closure)
            // But if there's an overlapping blocker, it will be handled below
            if (!segmentType) {
                status = 'available';
            } else if (segmentType === 'appointment') {
                status = 'busy';
            } else {
                status = 'closed';
            }
        } else if (segmentType === 'appointment') {
            status = 'busy';
        } else if (segmentType === 'closure' || segmentType === 'reserved' || segmentType === 'break') {
            status = 'closed';
        } else {
            // Empty segment - check if service fits
            const segmentDuration = actualEnd - actualStart;

            // CRITICAL: Check if placing service at actualStart would overlap with any blocker
            // Service would run from actualStart to actualStart + duration
            const serviceEndMin = actualStart + duration;

            let overlaps = false;
            for (const iv of merged) {
                // Service (actualStart to serviceEndMin) overlaps with blocker (iv.start to iv.end)
                if (actualStart < iv.end && serviceEndMin > iv.start) {
                    overlaps = true;
                    break;
                }
            }

            if (overlaps || segmentDuration < duration) {
                status = 'notAvailable';
            } else {
                status = 'available';
            }
        }

        slots.push({
            start: minutesToHHMM(actualStart),
            end: minutesToHHMM(actualEnd),
            status: status
        });
    }

    // ====== STEP 7: Filter Past Times for Today (REWRITTEN) ======
    // Three-way filter: drop fully-past, mark currently-running as 'inProgress', keep future as-is.
    // Day-end / full-day-closure fallbacks rewrite only when semantically correct.
    let filteredSlots = slots;
    let dayAlreadyOver = false;
    let dayFullyClosed = false;

    if (isToday && currentMinute !== null) {
        const closeMin = parseHHMM(endHour);

        // Durum A: Gün bitti (currentMinute >= closeMin)
        if (currentMinute >= closeMin) {
            dayAlreadyOver = true;
            filteredSlots = [];
        } else {
            // Üç-durumlu filtreleme
            filteredSlots = slots.flatMap(slot => {
                const slotStartMin = parseHHMM(slot.start);
                const slotEndMin   = parseHHMM(slot.end);

                // Tamamen geçmiş — at
                if (slotEndMin <= currentMinute) return [];

                // Şu anda devam ediyor — inProgress status'ü ile işaretle
                // (currentMinute slot.start'a eşitse henüz başlamamış sayılır)
                if (slotStartMin < currentMinute && slotEndMin > currentMinute) {
                    if (slot.status === 'available') {
                        return [{ ...slot, status: 'inProgress' }];
                    }
                    return [slot]; // busy/closed/notAvailable — koru
                }

                // Gelecek — olduğu gibi koru
                return [slot];
            });

            // Full-day closure sinyali: flatMap sonrası tüm slotlar non-available ise
            // (örn. tüm gün closure + isToday=true)
            if (filteredSlots.length > 0 && filteredSlots.every(s => s.status !== 'available')) {
                const allClosed = filteredSlots.every(s => s.status === 'closed');
                if (allClosed) {
                    dayFullyClosed = true;
                }
            }

            // Fallback (yeniden yazıldı): sadece gerçek full-day closure durumunda tüm günü closed yap
            if (filteredSlots.length === 0 && slots.length > 0) {
                const hasAnyNonAvailable = slots.some(s =>
                    s.status === 'busy' || s.status === 'closed' || s.status === 'notAvailable'
                );
                if (hasAnyNonAvailable) {
                    // Gerçek closure var — orijinal status'ları koru
                    filteredSlots = slots;
                    dayFullyClosed = true;
                } else {
                    // Hepsi available'dı ama hepsi geçmiş — gün bitti
                    filteredSlots = [];
                    dayAlreadyOver = true;
                }
            }
        }
    }

    // ====== STEP 8: Build Response ======
    return {
        slots: filteredSlots,
        dayAlreadyOver,
        dayFullyClosed,
        settings: {
            open_time: startHour,
            close_time: endHour,
            slot_time: settings.slotTime || settings.slot_time || 60,
            duration: duration
        }
    };
}

module.exports = { generateSlotsV2Engine, parseHHMM, minutesToHHMM };