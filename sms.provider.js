// sms.provider.js
// SMS Provider soyut katmanı - MesajPaneli ve NetGSM desteği
const axios = require('axios');
const https = require('https');
const { env } = require("./config");

class SmsProvider {
    async topluMesajGonder(msgBaslik, topluMesaj, tr = false, start = null) {
        throw new Error("Not implemented");
    }
}

/**
 * MesajPaneli Sağlayıcısı
 * Mevcut MesajPaneliApi.js mantığını korur
 */
class MesajPaneliProvider extends SmsProvider {
    constructor() {
        super();
        const user = env("SMS_USER", "");
        const pass = env("SMS_PASS", "");
        const endpoint = env("SMS_ENDPOINT", "https://api.mesajpaneli.com/json_api/api");
        const verifySSL = String(env("SMS_VERIFY_SSL", "true")).toLowerCase() !== "false";

        this.credentials = { username: user, password: pass };
        this.endpoint = endpoint;
        this.verifySSL = verifySSL;
        this.timeout = 50_000;
    }

    async topluMesajGonder(msgBaslik, topluMesaj, tr = false, start = null) {
        if (!msgBaslik || String(msgBaslik).length < 3) {
            throw new Error("Başlık minimum 3 karakterden oluşmalıdır.");
        }
        if (!topluMesaj?.metin || !topluMesaj?.telefon) {
            throw new Error("Mesaj metni ve telefon zorunludur.");
        }

        const payload = {
            user: { name: this.credentials.username, pass: this.credentials.password },
            msgBaslik: msgBaslik,
            tr: !!tr,
            msgData: [
                {
                    msg: topluMesaj.metin,
                    tel: [String(topluMesaj.telefon)],
                },
            ],
        };

        if (start != null) payload.start = start;

        const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
        const form = new URLSearchParams({ data: b64 });

        const httpsAgent = this.verifySSL
            ? undefined
            : new https.Agent({ rejectUnauthorized: false });

        console.log("[MesajPaneli Request]", {
            url: this.endpoint,
            payload: {
                user: { name: this.credentials.username, pass: "***" },
                msgBaslik,
                tr,
                msgData: [{ msg: topluMesaj.metin, tel: [topluMesaj.telefon] }],
            }
        });

        const res = await axios.post(this.endpoint, form, {
            timeout: this.timeout,
            headers: { "User-Agent": "NODE_API" },
            httpsAgent,
        });

        console.log("[MesajPaneli Response]", {
            status: res.status,
            data: res.data,
        });

        const decoded = Buffer.from(String(res.data), "base64").toString("utf8");

        let json;
        try {
            json = JSON.parse(decoded);
        } catch {
            throw new Error("API response JSON parse edilemedi: " + decoded);
        }

        if (json?.status === false) {
            throw new Error(json?.error || "Girilen bilgileri kontrol ediniz");
        }

        return json;
    }

    getProviderName() {
        return "mesajpaneli";
    }
}

/**
 * NetGSM Sağlayıcısı
 * netgsm_test/app.js referans alınarak implement edildi
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
 * SMS_PROVIDER env değişkeniyle seçim yapılır
 * Varsayılan: netgsm
 */
function createSmsProvider() {
    const provider = env("SMS_PROVIDER", "netgsm");
    console.log("[SMS Provider] Seçilen provider:", provider, "| Env değeri:", process.env.SMS_PROVIDER);

    if (provider === "mesajpaneli") {
        return new MesajPaneliProvider();
    }

    return new NetGsmProvider();
}

/**
 * Mesaj yapısı (MesajPaneliApi.js ile uyumlu)
 */
class TopluMesaj {
    constructor(metin, telefon) {
        this.metin = metin;
        this.telefon = String(telefon);
    }
}

module.exports = {
    SmsProvider,
    MesajPaneliProvider,
    NetGsmProvider,
    TopluMesaj,
    createSmsProvider,
};