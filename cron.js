// cron.js
const cron = require("node-cron");
const { runJobs } = require("./scheduler");

function startScheduler() {
    // Her 5 dakikada bir çalış
    cron.schedule('*/5 * * * *', async () => {
        console.log('[CRON] Zamanlı işlem başlatıldı');
        await runJobs();
    });
    console.log('[CRON] Scheduler başlatıldı (her 5 dakikada)');
}

module.exports = { startScheduler };
