// sms.provider.js
// SMS Provider - NetGSM desteği
const axios = require('axios');
const https = require('https');
const { env } = require("./config");

class SmsProvider {
    async topluMesajGonder(msgBaslik, topluMesaj, tr = false, start = null) {
        throw new Error("Not implemented");
    }
}

/**
 * NetGSM Sağlayıcısı
 */
class NetGsmProvider extends SmsProvider {
    constructor() {
        super();
        this.user = env("NETGSM_USER", "");
        this.pass = env("NETGSM_PASS", "");
        this.header = env("NETGSM_HEADER", "");
        this.endpoint = env("NETGSM_ENDPOINT", "https://api.netgsm.com.tr/sms/send/get/");
        this.verifySSL = String(env("NETGSM_VERIFY_SSL", "true")).toLowerCase() !== "false";
        this.timeout = 50_000;
    }

    async topluMesajGonder(msgBaslik, topluMesaj, tr = false, start = null) {
        if (!msgBaslik || String(msgBaslik).length < 3) {
            throw new Error("Başlık minimum 3 karakterden oluşmalıdır.");
        }
        if (!topluMesaj?.metin || !topluMesaj?.telefon) {
            throw new Error("Mesaj metni ve telefon zorunludur.");
        }

        const params = new URLSearchParams({
            usercode: this.user,
            password: this.pass,
            gsmno: String(topluMesaj.telefon),
            message: topluMesaj.metin,
            msgheader: msgBaslik,
            dil: 'TR',
        });

        const httpsAgent = this.verifySSL
            ? undefined
            : new https.Agent({ rejectUnauthorized: false });

        const requestUrl = `${this.endpoint}?${params.toString()}`;

        console.log("[NetGSM Request]", {
            url: this.endpoint,
            params: {
                usercode: this.user,
                password: "***",
                gsmno: topluMesaj.telefon,
                message: topluMesaj.metin,
                msgheader: msgBaslik,
                dil: 'TR',
            }
        });

        const response = await axios.get(requestUrl, {
            timeout: this.timeout,
            headers: { "User-Agent": "NODE_API" },
            httpsAgent,
        });

        console.log("[NetGSM Response]", {
            status: response.status,
            data: response.data,
        });

        // API yanıtını string'e çevir
        let responseText = response.data;
        if (typeof responseText !== 'string') {
            responseText = JSON.stringify(responseText);
        }

        const [code, jobId] = responseText.split(' ');

        if (code === '00') {
            return {
                status: true,
                msg_id: jobId,
                jobId: jobId,
                provider: "netgsm"
            };
        } else {
            throw new Error(`NetGSM hata kodu: ${code} - ${responseText}`);
        }
    }

    getProviderName() {
        return "netgsm";
    }
}

/**
 * Factory: SMS provider oluştur
 */
function createSmsProvider() {
    return new NetGsmProvider();
}

/**
 * Mesaj yapısı
 */
class TopluMesaj {
    constructor(metin, telefon) {
        this.metin = metin;
        this.telefon = String(telefon);
    }
}

module.exports = {
    SmsProvider,
    NetGsmProvider,
    TopluMesaj,
    createSmsProvider,
};
