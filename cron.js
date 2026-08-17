// cron.js
const cron = require("node-cron");
const { runJobs } = require("./scheduler");
const { runReservedSlotAppointments } = require("./reservation");

function startScheduler() {
    // Her 5 dakikada bir çalış
    cron.schedule('*/5 * * * *', async () => {
        console.log('[CRON] Zamanlı işlem başlatıldı');
        await runJobs();
    });

    // Her Pazar 23:59 — reserved slotlardan randevu oluştur
    cron.schedule('59 23 * * 0', async () => {
        console.log('[CRON] Haftalık reserved slot job başladı');
        await runReservedSlotAppointments();
    });

    console.log('[CRON] Scheduler başlatıldı');
}

module.exports = { startScheduler };
