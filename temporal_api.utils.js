/**
 * temporal_api.utils.js
 *
 * Backend Temporal API yardımcıları - Node.js 26+
 * Tüm tarih/saat işlemleri için tek merkez.
 *
 * Kullanım:
 *   const { now, addDaysToYmd, diffMinutes, ... } = require('./temporal_api.utils');
 */

// ===============================
// CONFIG
// ===============================

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || 'Europe/Istanbul';

// ===============================
// TIMEZONE
// ===============================

/**
 * Business timezone döner
 * @returns {string} IANA timezone (örn: 'Europe/Istanbul')
 */
function getBusinessTimezone() {
    return BUSINESS_TZ;
}

// ===============================
// CONVERSIONS - DB Format <-> Temporal
// ===============================

/**
 * DB DATETIME string → Temporal.PlainDateTime
 * DB format: "2026-06-05 13:30:00" veya "2026-06-05T13:30:00+03:00[Europe/Istanbul]"
 *
 * @param {string|null} sqlDt - DB datetime string
 * @returns {Temporal.PlainDateTime|null}
 */
function fromDBDateTime(sqlDt) {
    if (!sqlDt) return null;
    const str = String(sqlDt).trim();
    if (!str) return null;
    // ZonedDateTime formatı kontrolü
    if (str.includes('[') || str.includes('+') || str.endsWith('Z')) {
        try {
            return Temporal.ZonedDateTime.from(str).toPlainDateTime();
        } catch {
            // Fallback
        }
    }
    // Plain format: "2026-06-05 13:30:00" → "2026-06-05T13:30:00"
    const normalized = str.replace(' ', 'T').slice(0, 19);
    try {
        return Temporal.PlainDateTime.from(normalized);
    } catch {
        return null;
    }
}

/**
 * Temporal → DB DATETIME string (geriye uyumlu format)
 * Format: "YYYY-MM-DD HH:MM:SS"
 *
 * @param {Temporal.PlainDateTime|Temporal.ZonedDateTime|null} temporal
 * @returns {string|null} SQL datetime string
 */
function toDBDateTime(temporal) {
    if (!temporal) return null;
    const pdt = temporal.toPlainDateTime ? temporal.toPlainDateTime() : temporal;
    const yyyy = String(pdt.year).padStart(4, '0');
    const mm = String(pdt.month).padStart(2, '0');
    const dd = String(pdt.day).padStart(2, '0');
    const hh = String(pdt.hour).padStart(2, '0');
    const mi = String(pdt.minute).padStart(2, '0');
    const ss = String(pdt.second).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/**
 * Temporal → ISO8601 string with timezone (yeni DB formatı)
 * Format: "2026-06-05T13:30:00+03:00[Europe/Istanbul]"
 *
 * @param {Temporal.ZonedDateTime|Temporal.PlainDateTime|null} temporal
 * @returns {string|null}
 */
function toISODateTime(temporal) {
    if (!temporal) return null;
    if (temporal.timeZoneId) {
        return temporal.toString();
    }
    // PlainDateTime → ZonedDateTime
    const zdt = temporal.toZonedDateTime(BUSINESS_TZ);
    return zdt.toString();
}

/**
 * YYYY-MM-DD string → Temporal.PlainDate
 *
 * @param {string|null} ymd - "2026-06-05"
 * @returns {Temporal.PlainDate|null}
 */
function fromYmd(ymd) {
    if (!ymd) return null;
    return Temporal.PlainDate.from(String(ymd));
}

/**
 * Temporal.PlainDate → YYYY-MM-DD string
 *
 * @param {Temporal.PlainDate|null} date
 * @returns {string}
 */
function toYmd(date) {
    if (!date) return '';
    return date.toString(); // PlainDate.toString() zaten YYYY-MM-DD döner
}

/**
 * HH:MM string → Temporal.PlainTime
 *
 * @param {string|null} hhmm - "13:30"
 * @returns {Temporal.PlainTime|null}
 */
function fromHHMM(hhmm) {
    if (!hhmm) return null;
    const [h, m] = String(hhmm).split(':').map(Number);
    return Temporal.PlainTime.from({ hour: h, minute: m });
}

/**
 * Temporal.PlainTime → HH:MM string
 *
 * @param {Temporal.PlainTime|null} time
 * @returns {string}
 */
function toHHMM(time) {
    if (!time) return '';
    return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

/**
 * PlainDateTime + timezone → ZonedDateTime
 *
 * @param {Temporal.PlainDateTime} plainDateTime
 * @param {string} tz - IANA timezone (varsayılan: BUSINESS_TZ)
 * @returns {Temporal.ZonedDateTime}
 */
function toBusinessZonedDateTime(plainDateTime, tz = BUSINESS_TZ) {
    return plainDateTime.toZonedDateTime(tz);
}

// ===============================
// CURRENT TIME
// ===============================

/**
 * Şu anki zaman - Temporal.ZonedDateTime
 *
 * @returns {Temporal.ZonedDateTime}
 */
function now() {
    return Temporal.Now.zonedDateTimeISO(BUSINESS_TZ);
}

/**
 * Bugünün tarihi - YYYY-MM-DD string
 *
 * @returns {string}
 */
function todayYmd() {
    return Temporal.Now.plainDateISO().toString();
}

/**
 * Şu anki saat (0-23)
 *
 * @returns {number}
 */
function currentHour() {
    return Temporal.Now.zonedDateTimeISO(BUSINESS_TZ).hour;
}

/**
 * Şu anki dakika (0-59)
 *
 * @returns {number}
 */
function currentMinute() {
    return Temporal.Now.zonedDateTimeISO(BUSINESS_TZ).minute;
}

/**
 * Şu anki günün haftanın kaçıncı günü (1=Pazartesi, 7=Pazar)
 * Temporal.PlainDate dayOfWeek: 1=Pazartesi, 7=Pazar
 *
 * @returns {number}
 */
function currentDayOfWeek() {
    return Temporal.Now.plainDateISO().dayOfWeek;
}

// ===============================
// ARITHMETIC - TEMPORAL İLE (IMMUTABLE!)
// ===============================

/**
 * YYYY-MM-DD string'e gün ekle (IMMUTABLE!)
 *
 * @param {string} ymd - Başlangıç tarihi "2026-06-05"
 * @param {number} days - Eklenecek gün sayısı (negatif = çıkar)
 * @returns {string} Yeni tarih "2026-06-12"
 *
 * @example
 *   addDaysToYmd('2026-06-05', 7)  // → "2026-06-12"
 *   addDaysToYmd('2026-06-05', -3) // → "2026-06-02"
 */
function addDaysToYmd(ymd, days) {
    if (!ymd) return '';
    const date = Temporal.PlainDate.from(ymd);
    return date.add({ days: Number(days || 0) }).toString();
}

/**
 * YYYY-MM-DD string'e ay ekle (IMMUTABLE!)
 * Ay sonuna dikkat: 31 Ocak + 1 ay = 28 Şubat (constrain)
 *
 * @param {string} ymd - Başlangıç tarihi
 * @param {number} months - Eklenecek ay sayısı
 * @returns {string}
 */
function addMonthsToYmd(ymd, months) {
    if (!ymd) return '';
    const date = Temporal.PlainDate.from(ymd);
    return date.add({ months: Number(months || 0) }).toString();
}

/**
 * HH:MM string'e dakika ekle (IMMUTABLE!)
 * 23:30 + 60dk = 00:30 (ertesi güne sarar)
 *
 * @param {string} hhmm - Başlangıç saati "13:30"
 * @param {number} minutes - Eklenecek dakika
 * @returns {string} Yeni saat "14:30"
 */
function addMinutesToTime(hhmm, minutes) {
    if (!hhmm) return '';
    const [h, m] = String(hhmm).split(':').map(Number);
    const time = Temporal.PlainTime.from({ hour: h, minute: m });
    const result = time.add({ minutes: Number(minutes || 0) });
    return `${String(result.hour).padStart(2, '0')}:${String(result.minute).padStart(2, '0')}`;
}

/**
 * İki datetime arasındaki fark (dakika)
 *
 * @param {string|Temporal.PlainDateTime} startValue - Başlangıç
 * @param {string|Temporal.PlainDateTime} endValue - Bitiş
 * @returns {number} Dakika farkı
 *
 * @example
 *   diffMinutes('2026-06-05 13:30:00', '2026-06-05 14:45:00') // → 75
 */
function diffMinutes(startValue, endValue) {
    let start, end;

    if (startValue instanceof Temporal.PlainDateTime) {
        start = startValue;
    } else {
        const s = String(startValue).replace(' ', 'T').slice(0, 19);
        start = Temporal.PlainDateTime.from(s);
    }

    if (endValue instanceof Temporal.PlainDateTime) {
        end = endValue;
    } else {
        const e = String(endValue).replace(' ', 'T').slice(0, 19);
        end = Temporal.PlainDateTime.from(e);
    }

    const diff = start.until(end, { largestUnit: 'minutes' });
    return diff.minutes;
}

/**
 * Ayın son günü - TEMİZ HESAPLAMA (hack yok!)
 *
 * @param {number} year - Yıl (2026)
 * @param {number} month - Ay (1-12)
 * @returns {number} Ayın kaç gün çektiği (28-31)
 *
 * @example
 *   lastDayOfMonth(2026, 2)  // → 28 (artık yıl değil)
 *   lastDayOfMonth(2024, 2)  // → 29 (artık yıl)
 *   lastDayOfMonth(2026, 6)  // → 30
 */
function lastDayOfMonth(year, month) {
    const firstDay = Temporal.PlainDate.from({ year, month, day: 1 });
    return firstDay.daysInMonth;
}

/**
 * İki tarih arasındaki gün farkı
 *
 * @param {string} startYmd - Başlangıç "2026-06-01"
 * @param {string} endYmd - Bitiş "2026-06-30"
 * @returns {number} Gün farkı
 */
function diffDays(startYmd, endYmd) {
    const start = Temporal.PlainDate.from(startYmd);
    const end = Temporal.PlainDate.from(endYmd);
    return start.until(end, { largestUnit: 'days' }).days;
}

/**
 * Bir tarihin belirli bir tarihten sonra olup olmadığını kontrol et
 *
 * @param {string} ymd - Kontrol edilecek tarih
 * @param {string} afterYmd - Karşılaştırma tarihi
 * @returns {boolean}
 */
function isAfter(ymd, afterYmd) {
    return Temporal.PlainDate.compare(
        Temporal.PlainDate.from(ymd),
        Temporal.PlainDate.from(afterYmd)
    ) > 0;
}

/**
 * Bir tarihin belirli bir tarihten önce olup olmadığını kontrol et
 *
 * @param {string} ymd - Kontrol edilecek tarih
 * @param {string} beforeYmd - Karşılaştırma tarihi
 * @returns {boolean}
 */
function isBefore(ymd, beforeYmd) {
    return Temporal.PlainDate.compare(
        Temporal.PlainDate.from(ymd),
        Temporal.PlainDate.from(beforeYmd)
    ) < 0;
}

/**
 * Tarih aralığında mı kontrolü
 *
 * @param {string} ymd - Kontrol edilecek tarih
 * @param {string} startYmd - Aralık başı
 * @param {string} endYmd - Aralık sonu
 * @returns {boolean}
 */
function isBetween(ymd, startYmd, endYmd) {
    const date = Temporal.PlainDate.from(ymd);
    const start = Temporal.PlainDate.from(startYmd);
    const end = Temporal.PlainDate.from(endYmd);
    return Temporal.PlainDate.compare(date, start) >= 0
        && Temporal.PlainDate.compare(date, end) <= 0;
}

// ===============================
// SLOT CALCULATIONS
// ===============================

const VIRTUAL_SLOT_MINUTES = 5; // 5 dakikalık slotlar

/**
 * HH:MM string'i dakika cinsinden (günün başından itibaren) çevir
 *
 * @param {string} hhmm - "13:30"
 * @returns {number} 810 (13*60 + 30)
 */
function parseHHMMToMinutes(hhmm) {
    if (hhmm === null || hhmm === undefined || hhmm === '') return null;
    const [h, m] = String(hhmm).split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
}

/**
 * Dakika cinsinden (günün başından itibaren) HH:MM string'e çevir
 *
 * @param {number} totalMinutes - 810
 * @returns {string} "13:30"
 */
function minutesToHHMM(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Slot zamanlarını oluştur (appointment için)
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @param {number} startMin - Başlangıç dakikası (örn: 570 = 09:30)
 * @param {number} durationMin - Toplam süre (örn: 60)
 * @param {number} step - Slot aralığı (varsayılan: 5 dakika)
 * @returns {string[]} ["2026-06-05 09:30:00", "2026-06-05 09:35:00", ...]
 *
 * @example
 *   buildSlotTimes('2026-06-05', 570, 30, 5)
 *   // → ['2026-06-05 09:30:00', '2026-06-05 09:35:00', '2026-06-05 09:40:00',
 *   //      '2026-06-05 09:45:00', '2026-06-05 09:50:00', '2026-06-05 09:55:00']
 */
function buildSlotTimes(dateStr, startMin, durationMin, step = VIRTUAL_SLOT_MINUTES) {
    const slots = [];
    const startTime = Temporal.PlainTime.from({
        hour: Math.floor(startMin / 60),
        minute: startMin % 60
    });
    const startDateTime = Temporal.PlainDate.from(dateStr).toPlainDateTime(startTime);
    const endDateTime = startDateTime.add({ minutes: durationMin });

    let current = startDateTime;
    while (Temporal.PlainDateTime.compare(current, endDateTime) < 0) {
        const timeStr = `${String(current.hour).padStart(2, '0')}:${String(current.minute).padStart(2, '0')}:00`;
        slots.push(`${dateStr} ${timeStr}`);
        current = current.add({ minutes: step });
    }

    return slots;
}

/**
 * Slot range başlangıç ve bitiş datetime string'leri
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @param {number} startMin - Başlangıç dakikası
 * @param {number} blockDurationMin - Blok süresi
 * @returns {{ start: string, end: string }}
 */
function getSlotRange(dateStr, startMin, blockDurationMin) {
    const start = `${dateStr} ${minutesToHHMM(startMin)}:00`;
    const end = `${dateStr} ${minutesToHHMM(startMin + blockDurationMin)}:00`;
    return { start, end };
}

// ===============================
// FORMATTING
// ===============================

/**
 * Temporal/DB datetime → Türkçe format "DD/MM/YYYY HH:MM"
 *
 * @param {string|Temporal.PlainDateTime} value
 * @returns {string}
 */
function formatDateTime(value) {
    let dt;
    if (value instanceof Temporal.PlainDateTime) {
        dt = value;
    } else {
        dt = fromDBDateTime(value);
    }
    if (!dt) return '';

    const day = String(dt.day).padStart(2, '0');
    const month = String(dt.month).padStart(2, '0');
    const year = dt.year;
    const hour = String(dt.hour).padStart(2, '0');
    const minute = String(dt.minute).padStart(2, '0');
    return `${day}/${month}/${year} ${hour}:${minute}`;
}

/**
 * Temporal/DB datetime → Türkçe tam format "5 Haziran 2026 Perşembe 13:30"
 *
 * @param {string|Temporal.PlainDateTime|Temporal.ZonedDateTime} value
 * @returns {string}
 */
function formatForDisplay(value) {
    let dt;
    if (value instanceof Temporal.ZonedDateTime) {
        dt = value.toPlainDateTime();
    } else if (value instanceof Temporal.PlainDateTime) {
        dt = value;
    } else {
        dt = fromDBDateTime(value);
    }
    if (!dt) return '';

    return dt.toLocaleString('tr-TR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Sadece tarih → Türkçe "05/06/2026"
 *
 * @param {string|Temporal.PlainDate} value
 * @returns {string}
 */
function formatDate(value) {
    if (!value) return '';
    let d;
    if (value instanceof Temporal.PlainDate) {
        d = value;
    } else {
        d = fromYmd(String(value).slice(0, 10));
    }
    if (!d) return '';

    const day = String(d.day).padStart(2, '0');
    const month = String(d.month).padStart(2, '0');
    const year = d.year;
    return `${day}/${month}/${year}`;
}

/**
 * Sadece saat → "13:30"
 *
 * @param {string|Temporal.PlainTime} value
 * @returns {string}
 */
function formatTime(value) {
    let t;
    if (value instanceof Temporal.PlainTime) {
        t = value;
    } else {
        try {
            t = fromHHMM(String(value).slice(0, 5));
        } catch {
            return '';
        }
    }
    if (!t) return '';

    return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

/**
 * YYYY-MM-DD + HH:MM → SQL datetime string
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} timeStr - HH:MM
 * @returns {string} YYYY-MM-DD HH:MM:SS
 */
function toSqlDateTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    return `${dateStr} ${timeStr}:00`;
}

/**
 * SQL datetime string → { dateStr, timeStr }
 *
 * @param {string} sqlDt - YYYY-MM-DD HH:MM:SS
 * @returns {{ dateStr: string, timeStr: string }}
 */
function extractDateTimeParts(sqlDt) {
    if (!sqlDt) return { dateStr: '', timeStr: '' };

    const str = String(sqlDt);
    const [datePart, timePart] = str.split(' ');
    const timeStr = (timePart || '').slice(0, 5);

    return { dateStr: datePart || '', timeStr };
}

// ===============================
// VALIDATION
// ===============================

/**
 * YYYY-MM-DD formatında mı kontrol et
 *
 * @param {string} ymd
 * @returns {boolean}
 */
function isValidYmd(ymd) {
    if (!ymd) return false;
    const pattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!pattern.test(ymd)) return false;

    try {
        Temporal.PlainDate.from(ymd);
        return true;
    } catch {
        return false;
    }
}

/**
 * HH:MM formatında mı kontrol et
 *
 * @param {string} hhmm
 * @returns {boolean}
 */
function isValidHhmm(hhmm) {
    if (!hhmm) return false;
    const pattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
    return pattern.test(hhmm);
}

/**
 * Verilen saatin işletme saatleri içinde olup olmadığını kontrol et
 *
 * @param {string} hhmm - Kontrol edilecek saat "14:30"
 * @param {string} openHhmm - Açılış saati "09:00"
 * @param {string} closeHhmm - Kapanış saati "22:00"
 * @returns {boolean}
 */
function isWithinBusinessHours(hhmm, openHhmm, closeHhmm) {
    const timeMin = parseHHMMToMinutes(hhmm);
    const openMin = parseHHMMToMinutes(openHhmm);
    const closeMin = parseHHMMToMinutes(closeHhmm);

    if (timeMin === null || openMin === null || closeMin === null) return false;
    return timeMin >= openMin && timeMin < closeMin;
}

/**
 * İki datetime'dan hangisinin önce olduğunu karşılaştır
 *
 * @param {string} a - SQL datetime
 * @param {string} b - SQL datetime
 * @returns {number} -1 (a < b), 0 (a === b), 1 (a > b)
 */
function compareDateTime(a, b) {
    const dtA = fromDBDateTime(a);
    const dtB = fromDBDateTime(b);
    return Temporal.PlainDateTime.compare(dtA, dtB);
}

// ===============================
// SPECIAL OPERATIONS
// ===============================

/**
 * Bir datetime'ın süresi dolmuş mu kontrol et (OTP için)
 *
 * @param {string} expiryDt - Bitiş datetime
 * @returns {boolean}
 */
function isExpired(expiryDt) {
    if (!expiryDt) return true;
    const exp = fromDBDateTime(expiryDt);
    if (!exp) return true;

    const nowDt = now().toPlainDateTime();
    return Temporal.PlainDateTime.compare(exp, nowDt) <= 0;
}

/**
 * Bir datetime'ın belirli bir süre önce olup olmadığını kontrol et
 *
 * @param {string} targetDt - Hedef datetime
 * @param {number} hoursAgo - Kaç saat önce
 * @returns {boolean}
 */
function isHoursAgo(targetDt, hoursAgo) {
    const target = fromDBDateTime(targetDt);
    if (!target) return false;

    const threshold = now().subtract({ hours: hoursAgo }).toPlainDateTime();
    return Temporal.PlainDateTime.compare(target, threshold) < 0;
}

/**
 * Datetime'ın yaklaşan randevu olup olmadığını kontrol et
 *
 * @param {string} startAtDt - Randevu başlangıcı
 * @param {number} withinHours - Kaç saat içinde
 * @returns {boolean}
 */
function isWithinHours(startAtDt, withinHours) {
    const start = fromDBDateTime(startAtDt);
    if (!start) return false;

    const nowDt = now().toPlainDateTime();
    const threshold = nowDt.add({ hours: withinHours });

    return Temporal.PlainDateTime.compare(start, nowDt) >= 0
        && Temporal.PlainDateTime.compare(start, threshold) <= 0;
}

/**
 * Hafta sonu mı (Cumartesi veya Pazar)
 *
 * @param {string} ymd - YYYY-MM-DD
 * @returns {boolean}
 */
function isWeekend(ymd) {
    const date = Temporal.PlainDate.from(ymd);
    return date.dayOfWeek === 6 || date.dayOfWeek === 7;
}

/**
 * Hafta içi mi (Pazartesi - Cuma)
 *
 * @param {string} ymd - YYYY-MM-DD
 * @returns {boolean}
 */
function isWeekday(ymd) {
    return !isWeekend(ymd);
}

// ===============================
// TIMESTAMP HELPERS (INSERT/UPDATE)
// ===============================

/**
 * INSERT için timestamp data ekle
 * created_at ve updated_at otomatik olarak şimdiki zaman ile doldurulur
 *
 * @param {Object} data - { field1: val1, ... }
 * @returns {Object} - { field1: val1, created_at: now, updated_at: now }
 */
function forInsert(data) {
    const nowStr = toISODateTime(now());
    return { ...data, created_at: nowStr, updated_at: nowStr };
}

/**
 * UPDATE için timestamp data ekle
 * sadece updated_at otomatik olarak şimdiki zaman ile doldurulur
 *
 * @param {Object} data - { field1: val1, ... }
 * @returns {Object} - { field1: val1, updated_at: now }
 */
function forUpdate(data) {
    return { ...data, updated_at: toISODateTime(now()) };
}

// ===============================
// EXPORTS
// ===============================

module.exports = {
    // Config
    getBusinessTimezone,

    // Conversions
    fromDBDateTime,
    toDBDateTime,
    toISODateTime,
    fromYmd,
    toYmd,
    fromHHMM,
    toHHMM,
    toBusinessZonedDateTime,

    // Current time
    now,
    todayYmd,
    currentHour,
    currentMinute,
    currentDayOfWeek,

    // Arithmetic
    addDaysToYmd,
    addMonthsToYmd,
    addMinutesToTime,
    diffMinutes,
    diffDays,
    lastDayOfMonth,
    isAfter,
    isBefore,
    isBetween,

    // Slot calculations
    VIRTUAL_SLOT_MINUTES,
    parseHHMMToMinutes,
    minutesToHHMM,
    buildSlotTimes,
    getSlotRange,

    // Formatting
    formatDateTime,
    formatForDisplay,
    formatDate,
    formatTime,
    toSqlDateTime,
    extractDateTimeParts,

    // Validation
    isValidYmd,
    isValidHhmm,
    isWithinBusinessHours,
    compareDateTime,
    isExpired,
    isHoursAgo,
    isWithinHours,
    isWeekend,
    isWeekday,

    // Timestamp helpers
    forInsert,
    forUpdate,
};
