// whatsapp.js
// WhatsApp Cloud API Provider
const axios = require('axios');
const { env } = require("./config");

class WhatsAppProvider {
    async sendMessage(to, body, options = {}) {
        throw new Error("Not implemented");
    }

    async sendTemplate(to, templateName, components, languageCode = 'tr') {
        throw new Error("Not implemented");
    }
}

/**
 * WhatsApp Cloud API Sağlayıcısı
 * Meta'nın WhatsApp Business Platform API'si üzerinden mesaj gönderir
 */
class WhatsAppCloudProvider extends WhatsAppProvider {
    constructor() {
        super();
        this.phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID", "");
        this.businessAccountId = env("WHATSAPP_BUSINESS_ACCOUNT_ID", "");
        this.appId = env("WHATSAPP_APP_ID", "");
        this.appSecret = env("WHATSAPP_APP_SECRET", "");
        this.accessToken = env("WHATSAPP_ACCESS_TOKEN", "");
        this.apiVersion = 'v18.0';
        this.endpoint = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
        this.timeout = 30_000;
    }

    /**
     * Text mesaj gönder
     */
    async sendMessage(to, body) {
        if (!to || !body) {
            throw new Error("Telefon numarası ve mesaj içeriği zorunludur.");
        }

        // Telefon numarasını temizle (boşluk, + işareti vs.)
        const cleanPhone = this.cleanPhoneNumber(to);

        const payload = {
            messaging_product: "whatsapp",
            to: cleanPhone,
            type: "text",
            text: {
                body: body
            }
        };

        console.log("[WhatsApp Cloud API] Sending message", {
            to: cleanPhone,
            bodyLength: body.length
        });

        const response = await this.makeRequest(payload);

        console.log("[WhatsApp Cloud API] Response:", response);

        return {
            status: true,
            message_id: response.messages?.[0]?.id || null,
            wa_message_id: response.messages?.[0]?.id || null,
            provider: "whatsapp_cloud"
        };
    }

    /**
     * Template mesaj gönder
     */
    async sendTemplate(to, templateName, components = [], languageCode = 'tr') {
        if (!to || !templateName) {
            throw new Error("Telefon numarası ve template adı zorunludur.");
        }

        const cleanPhone = this.cleanPhoneNumber(to);

        const payload = {
            messaging_product: "whatsapp",
            to: cleanPhone,
            type: "template",
            template: {
                name: templateName,
                language: {
                    code: languageCode
                },
                components: components
            }
        };

        console.log("[WhatsApp Cloud API] Sending template", {
            to: cleanPhone,
            template: templateName
        });

        const response = await this.makeRequest(payload);

        return {
            status: true,
            message_id: response.messages?.[0]?.id || null,
            wa_message_id: response.messages?.[0]?.id || null,
            template_name: templateName,
            provider: "whatsapp_cloud"
        };
    }

    /**
     * HTTP isteği yap
     */
    async makeRequest(payload) {
        const response = await axios.post(this.endpoint, payload, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: this.timeout
        });

        return response.data;
    }

    /**
     * Telefon numarasını temizle
     */
    cleanPhoneNumber(phone) {
        // Tüm boşlukları, tireleri ve + işaretini kaldır
        return String(phone).replace(/[\s\-+]/g, '');
    }

    getProviderName() {
        return "whatsapp_cloud";
    }
}

/**
 * Factory: WhatsApp provider oluştur
 */
function createWhatsAppProvider() {
    return new WhatsAppCloudProvider();
}

module.exports = {
    WhatsAppProvider,
    WhatsAppCloudProvider,
    createWhatsAppProvider,
};
