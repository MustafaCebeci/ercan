// MesajPaneliApi.js
const axios = require('axios');
const https = require('https');

class CredentialsUsernamePassword {
    constructor(username, password) {
        this.username = username;
        this.password = password;
    }
}

class TopluMesaj {
    // PHP: new TopluMesaj('test', '5467473915')
    constructor(metin, telefon) {
        this.metin = metin;
        this.telefon = String(telefon);
    }
}

class MesajPaneliApi {
    constructor(credentials, options = {}) {
        this.credentials = credentials;

        // PHP dosyandaki endpoint formatına uygun
        this.endpoint = options.endpoint ?? "https://api.mesajpaneli.com/json_api/api";

        // Sertifika hatası yaşarsan options.verifySSL=false ver
        this.verifySSL = options.verifySSL ?? true;

        this.timeout = options.timeout ?? 50_000;
    }

    async topluMesajGonder(msgBaslik, topluMesaj, tr = false, start = null) {
        if (!msgBaslik || String(msgBaslik).length < 3) {
            throw new Error("Başlık minimum 3 karakterden oluşmalıdır.");
        }
        if (!topluMesaj?.metin || !topluMesaj?.telefon) {
            throw new Error("Mesaj metni ve telefon zorunludur.");
        }

        // API payload (PHP paketin yaptığı gibi)
        const payload = {
            user: { name: this.credentials.username, pass: this.credentials.password },
            msgBaslik: msgBaslik,
            tr: !!tr,
            msgData: [
                {
                    msg: topluMesaj.metin,
                    tel: [topluMesaj.telefon],
                },
            ],
        };

        if (start != null) payload.start = start;

        // PHP: data=base64(json)
        const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
        const form = new URLSearchParams({ data: b64 });

        const httpsAgent = this.verifySSL
            ? undefined
            : new https.Agent({ rejectUnauthorized: false });

        const res = await axios.post(this.endpoint, form, {
            timeout: this.timeout,
            headers: { "User-Agent": "NODE_API" },
            httpsAgent,
        });

        // API response base64 -> decode -> JSON
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
}

module.exports = {
    CredentialsUsernamePassword,
    TopluMesaj,
    MesajPaneliApi,
}