/**
 * reservation.js
 *
 * Reserved slotlardan otomatik randevu oluşturma cron job'u.
 * Her Pazar 23:59'da çalışarak önümüzdeki hafta için reserved slotlardan
 * gerçek randevu oluşturur.
 *
 * Bu modül bağımsızdır — scheduler.js'e bağlı değildir.
 */

const { pool } = require("./models");
const t = require("./temporal_api.utils");

const VIRTUAL_SLOT_MINUTES = 5;

const DAY_NAME_TO_WEEKDAY = {
    'monday': 1, 'tuesday': 2, 'wednesday': 3,
    'thursday': 4, 'friday': 5, 'saturday': 6, 'sunday': 7
};

// ============================================================
// Helpers
// ============================================================

function parseHHMMToMinutes(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
}

function roundUpToStep(minutes, step) {
    return Math.ceil(minutes / step) * step;
}

function buildSlotTimes(dateStr, startMin, blockDurationMin) {
    const slots = [];
    for (let t2 = startMin; t2 < startMin + blockDurationMin; t2 += VIRTUAL_SLOT_MINUTES) {
        const hh = String(Math.floor(t2 / 60)).padStart(2, '0');
        const mm = String(t2 % 60).padStart(2, '0');
        slots.push(`${dateStr} ${hh}:${mm}:00`);
    }
    return slots;
}

/**
 * Önümüzdeki haftanın Pazartesi ve Pazar tarihlerini döner (YYYY-MM-DD).
 * Cron Pazar 23:59'da çalıştığı için "next week" önümüzdeki haftadır.
 */
function getNextWeekRange() {
    const now = t.now();
    const todayPlain = Temporal.PlainDate.from(now); // ZonedDateTime → PlainDate
    const todayDayOfWeek = todayPlain.dayOfWeek; // 1=Pazartesi, 7=Pazar

    // Pazar günkü çalışmada todayDayOfWeek === 7
    // Sonraki Pazartesi = bugün + (8 - todayDayOfWeek) gün
    // (örn: Çarşamba(3) → 8-3=5 gün sonra, Pazar(7) → 1 gün sonra)
    const daysUntilMonday = todayDayOfWeek === 7 ? 1 : (8 - todayDayOfWeek);
    const nextMonday = todayPlain.add({ days: daysUntilMonday });
    const nextSunday = nextMonday.add({ days: 6 });

    return {
        monday: nextMonday.toString(), // 'YYYY-MM-DD'
        sunday: nextSunday.toString(), // 'YYYY-MM-DD'
        mondayObj: nextMonday,
    };
}

/**
 * Reserved slot'ın day_of_week değerini YYYY-MM-DD'ye çevirir.
 */
function reservedSlotToDate(dayOfWeek, weekMondayObj) {
    const targetWeekday = DAY_NAME_TO_WEEKDAY[String(dayOfWeek).toLowerCase()];
    if (!targetWeekday) return null;
    const dayOffset = targetWeekday - 1; // Pazartesi = 0
    return weekMondayObj.add({ days: dayOffset }).toString();
}

// ============================================================
// Main
// ============================================================

/**
 * Her Pazar 23:59'da çalışır.
 * Önümüzdeki hafta için reserved slotlardan randevu oluşturur.
 * Çakışma varsa atlanır.
 */
async function runReservedSlotAppointments() {
    let created = 0;
    let skipped = 0;

    try {
        console.log("[RESERVATION] Reserved slot randevu işlemi başladı");

        const { monday, sunday, mondayObj } = getNextWeekRange();
        console.log(`[RESERVATION] Hedef hafta: ${monday} - ${sunday}`);

        // Tüm aktif reserved slotları al
        const [rsRows] = await pool.execute(`
            SELECT rs.*, sp.name AS provider_name, sp.provider_type
            FROM reserved_slots rs
            JOIN service_providers sp ON sp.id = rs.provider_id
            WHERE rs.is_active = 1
        `);

        if (!rsRows.length) {
            console.log("[RESERVATION] Aktif reserved slot yok, işlem tamamlandı");
            return;
        }

        console.log(`[RESERVATION] ${rsRows.length} reserved slot işleniyor`);

        for (const slot of rsRows) {
            // day_of_week → YYYY-MM-DD
            const targetDate = reservedSlotToDate(slot.day_of_week, mondayObj);
            if (!targetDate) { skipped++; continue; }

            // Tarih hedef hafta içinde mi?
            if (targetDate < monday || targetDate > sunday) { skipped++; continue; }

            // beginning kontrolü — hedef tarih beginning'den önceyse atla
            if (slot.beginning && targetDate < slot.beginning) {
                skipped++;
                continue;
            }

            // recurrence_weeks kontrolü
            const recWeeks = Number(slot.recurrence_weeks) || 1;
            if (recWeeks > 1) {
                if (slot.beginning) {
                    // beginning'e göre hesapla: beginning'den beri kaç hafta geçti?
                    const elapsedDays = t.diffDays(targetDate, slot.beginning);
                    const elapsedWeeks = Math.floor(elapsedDays / 7);
                    if (elapsedWeeks % recWeeks !== 0) {
                        skipped++;
                        continue;
                    }
                } else {
                    // beginning yok: ISO week mod (geriye uyumlu)
                    const isoWeek = mondayObj.weekOfYear;
                    if ((isoWeek % recWeeks) !== 0) {
                        skipped++;
                        continue;
                    }
                }
            }

            // Randevu oluştur
            const startAt = `${targetDate} ${String(slot.start_time).slice(0, 5)}:00`;
            const endAt = `${targetDate} ${String(slot.end_time).slice(0, 5)}:00`;
            const startMin = parseHHMMToMinutes(String(slot.start_time).slice(0, 5));
            const endMin = parseHHMMToMinutes(String(slot.end_time).slice(0, 5));
            const durationMin = endMin - startMin;
            const blockDurationMin = roundUpToStep(durationMin, VIRTUAL_SLOT_MINUTES);
            const slotTimes = buildSlotTimes(targetDate, startMin, blockDurationMin);

            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();

                const [r1] = await conn.execute(`
                    INSERT INTO appointments
                      (provider_id, service_id, is_custom, source, customer_id,
                       start_at, end_at,
                       service_name_snapshot, service_duration_minutes_snapshot, service_price_snapshot,
                       provider_name_snapshot, provider_type_snapshot,
                       customer_note)
                    VALUES
                      (?, NULL, 1, 'system', ?, ?, ?,
                       'Rezerve Slot', ?, NULL,
                       ?, ?,
                       ?)
                `, [
                    slot.provider_id,
                    slot.customer_id || null,
                    startAt,
                    endAt,
                    durationMin,
                    slot.provider_name,
                    slot.provider_type,
                    `Rezerve slot #${slot.id}: ${slot.note || ''}`
                ]);

                const appointmentId = r1.insertId;

                // appointment_slots
                if (slotTimes.length > 0) {
                    const slotValues = slotTimes.map(() => "(?, ?, ?)").join(", ");
                    const slotParams = [];
                    for (const st of slotTimes) {
                        slotParams.push(appointmentId, slot.provider_id, st);
                    }
                    await conn.execute(
                        `INSERT INTO appointment_slots (appointment_id, provider_id, slot_time) VALUES ${slotValues}`,
                        slotParams
                    );
                }

                // Status history
                await conn.execute(`
                    INSERT INTO appointment_status_history
                      (appointment_id, old_status, new_status, changed_by, note)
                    VALUES (?, 'confirmed', 'confirmed', 'system', ?)
                `, [appointmentId, `Rezerve slot #${slot.id}'dan oluşturuldu`]);

                await conn.commit();
                created++;
                console.log(`[RESERVATION] Randevu oluşturuldu: #${appointmentId} (reserved_slot #${slot.id})`);

            } catch (err) {
                await conn.rollback();
                if (err.code === 'ER_DUP_ENTRY') {
                    console.log(`[RESERVATION] Çakışma (dup): reserved_slot #${slot.id} atlanıyor`);
                    skipped++;
                } else {
                    console.error(`[RESERVATION] Randevu hatası (slot #${slot.id}):`, err.message);
                }
            } finally {
                conn.release();
            }
        }

        console.log(`[RESERVATION] Tamamlandı: ${created} oluşturuldu, ${skipped} atlanıldı`);

    } catch (err) {
        console.error("[RESERVATION] runReservedSlotAppointments hata:", err.message);
    }
}

module.exports = { runReservedSlotAppointments };
