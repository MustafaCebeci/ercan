/**
 * reserved-slot-expander.js
 *
 * Reserved slotları belirli bir tarih + provider için genişletir.
 * DB'deki reserved_slots tablosundan gelen veriyi slot-engine-v2'in beklediği
 * { start, end, source } formatına çevirir.
 *
 * weekly-break-rule-expander.js patternini takip eder.
 */

const t = require('../../temporal_api.utils');

const DAY_OF_WEEK_MAP = {
    1: 'monday',    // Temporal.PlainDate: 1=Pazartesi, 7=Pazar
    2: 'tuesday',
    3: 'wednesday',
    4: 'thursday',
    5: 'friday',
    6: 'saturday',
    7: 'sunday'
};

function parseHHMM(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
}

/**
 * Reserved slotları belirli bir tarih + provider için genişletir.
 *
 * @param {Object} params
 * @param {string} params.date          - YYYY-MM-DD hedef tarih
 * @param {Array}  params.reservedSlots - DB'den gelen row'lar
 * @param {number} params.providerId    - Hedef sağlayıcı
 * @returns {Array} [{ start, end, source, note }, ...]
 */
function expandReservedSlots({ date, reservedSlots, providerId }) {
    if (!date || !Array.isArray(reservedSlots) || !providerId) return [];

    let plainDate;
    try {
        plainDate = t.fromYmd(date);
    } catch {
        return [];
    }

    const dayOfWeek = plainDate.dayOfWeek;      // 1-7 (Temporal)
    const dayName = DAY_OF_WEEK_MAP[dayOfWeek]; // 'monday', ...

    const result = [];

    for (const slot of reservedSlots) {
        if (!slot.is_active) continue;
        if (Number(slot.provider_id) !== Number(providerId)) continue;
        if (String(slot.day_of_week).toLowerCase() !== dayName) continue;

        // beginning kontrolü: NULL = sonsuz, aksi halde sadece beginning >= date ise aktif
        if (slot.beginning && slot.beginning > date) continue;

        // recurrence_weeks: "her N hafta" pattern
        // 1 = her hafta, 2 = beginning'den itibaren her 2 hafta
        const recWeeks = Number(slot.recurrence_weeks) || 1;
        if (recWeeks > 1) {
            if (slot.beginning) {
                // beginning'e göre hesapla: beginning'den beri kaç hafta geçti?
                const elapsedDays = t.diffDays(date, slot.beginning);
                const elapsedWeeks = Math.floor(elapsedDays / 7);
                if (elapsedWeeks % recWeeks !== 0) continue;
            } else {
                // beginning yok: ISO week mod (geriye uyumlu)
                if ((plainDate.weekOfYear % recWeeks) !== 0) continue;
            }
        }

        const startMin = parseHHMM(slot.start_time);
        const endMin = parseHHMM(slot.end_time);
        if (endMin <= startMin) continue;

        result.push({
            start: String(slot.start_time).slice(0, 5),
            end: String(slot.end_time).slice(0, 5),
            source: 'reserved_slot',
            note: slot.note || null
        });
    }

    return result;
}

module.exports = { expandReservedSlots };
