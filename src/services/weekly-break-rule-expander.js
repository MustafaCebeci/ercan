/**
 * weekly-break-rule-expander.js
 *
 * Haftalık mola kurallarını belirli bir tarih için genişletir.
 * DB'deki { startHour, endHour } formatını engine'in beklediği { start, end } formatına çevirir.
 *
 * Temporal API kullanır (Node 26+).
 */

const t = require('../../temporal_api.utils');

const DAY_OF_WEEK_MAP = {
    1: 'monday',
    2: 'tuesday',
    3: 'wednesday',
    4: 'thursday',
    5: 'friday',
    6: 'saturday',
    7: 'sunday'
};

/**
 * Haftalık mola kurallarını belirli bir tarih için genişletir.
 *
 * @param {Object} params
 * @param {string} params.date - YYYY-MM-DD formatında hedef tarih
 * @param {Object} params.weeklyBreakRule - Haftalık mola kuralları (DB formatı)
 * @returns {Array} - [{start, end, note, source}, ...]
 */
function expandWeeklyBreakRules({ date, weeklyBreakRule }) {
    if (!date || !weeklyBreakRule) return [];

    let plainDate;
    try {
        plainDate = t.fromYmd(date);
    } catch {
        return [];
    }
    if (!plainDate) return [];

    const dayOfWeek = plainDate.dayOfWeek;
    const dayName = DAY_OF_WEEK_MAP[dayOfWeek];

    if (!dayName) return [];

    const dayBreaks = weeklyBreakRule[dayName];
    if (!Array.isArray(dayBreaks) || dayBreaks.length === 0) return [];

    const result = [];

    for (const brk of dayBreaks) {
        // Validation: startHour ve endHour null olmamalı
        if (!brk.startHour || !brk.endHour) continue;

        // Validation: Geçerli HH:MM formatı kontrolü
        if (!t.isValidHhmm(brk.startHour) || !t.isValidHhmm(brk.endHour)) continue;

        // Validation: end > start kontrolü
        const startMin = t.parseHHMMToMinutes(brk.startHour);
        const endMin = t.parseHHMMToMinutes(brk.endHour);
        if (endMin <= startMin) continue;

        result.push({
            start: brk.startHour,
            end: brk.endHour,
            note: brk.note || null,
            source: 'weekly_break_rule'
        });
    }

    return result;
}

module.exports = { expandWeeklyBreakRules };