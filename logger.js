// logger.js
// Request logging sistemi - her gün için ayrı log dosyası

const fs = require('fs');
const path = require('path');
const t = require('./temporal_api.utils');

const LOG_DIR = path.join(__dirname, 'logs');

// Klasör yoksa oluştur
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Günlük dosya adını döndür (YYYY-MM-DD.txt)
 */
function getLogFileName() {
    const z = t.now();
    const yyyy = String(z.year);
    const mm = String(z.month).padStart(2, '0');
    const dd = String(z.day).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}.txt`;
}

/**
 * Log dosyasının tam yolunu döndür
 */
function getLogPath() {
    return path.join(LOG_DIR, getLogFileName());
}

/**
 * Request'i logla
 * @param {Object} req - Express req object
 */
function logRequest(req) {
    try {
        const pdt = t.now().toPlainDateTime();
        const timestamp = `${pdt.year}-${String(pdt.month).padStart(2,'0')}-${String(pdt.day).padStart(2,'0')}T${String(pdt.hour).padStart(2,'0')}:${String(pdt.minute).padStart(2,'0')}:${String(pdt.second).padStart(2,'0')}.${String(pdt.millisecond).padStart(3,'0')}`;
        const ip = req.ip || req.connection?.remoteAddress || req.get('X-Forwarded-For') || '-';
        const method = req.method || '-';
        const reqPath = req.path || req.url || '-';
        const userAgent = req.get('user-agent') || '-';

        const logLine = `[${timestamp}] ${ip} ${method} ${reqPath} "${userAgent}"\n`;

        fs.appendFileSync(getLogPath(), logLine);
    } catch (err) {
        console.error('[LOGGER] Log yazma hatası:', err.message);
    }
}

module.exports = { logRequest };
