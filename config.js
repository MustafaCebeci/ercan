// config.js
require("dotenv").config();

// const axios = require("axios");
const nodemailer = require("nodemailer");

/**
 * ENV yardımcıları
 */
function env(key, fallback = undefined) {
    const v = process.env[key];
    return v === undefined || v === "" ? fallback : v;
}

function mustEnv(key) {
    const v = env(key);
    if (!v) throw new Error(`ENV eksik: ${key}`);
    return v;
}

/**
 * SMS Axios Client
 * - SMS provider yoksa da kullanılabilir (mock modunda servis çağırmayacağız)
 * - API key yoksa Authorization header hiç eklenmez
 */
function createSmsHttp() {
    /*const baseURL = env("SMS_API_BASE_URL", "http://localhost");
    const timeout = Number(env("SMS_TIMEOUT_MS", 15000));

    const headers = { "Content-Type": "application/json" };
    const apiKey = env("SMS_API_KEY");
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    return axios.create({ baseURL, timeout, headers });*/

    console.log("");
    
}

/**
 * Gmail OAuth2 transporter
 * - Her çağrıda transporter oluşturmak yerine cached kullanıyoruz
 */
let _mailerCache = { transporter: null, tokenExpiresAt: 0 };
/*
async function getMailer() {
    const now = Date.now();
    // 50 sn cache (OTP akışında yeter)
    if (_mailerCache.transporter && now < _mailerCache.tokenExpiresAt) {
        return _mailerCache.transporter;
    }

    const user = mustEnv("GMAIL_USER");
    const clientId = mustEnv("GOOGLE_CLIENT_ID");
    const clientSecret = mustEnv("GOOGLE_CLIENT_SECRET");
    const refreshToken = mustEnv("GOOGLE_REFRESH_TOKEN");

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const accessTokenResponse = await oauth2Client.getAccessToken();
    const accessToken = accessTokenResponse?.token;
    if (!accessToken) throw new Error("Gmail access token alınamadı.");

    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            type: "OAuth2",
            user,
            clientId,
            clientSecret,
            refreshToken,
            accessToken,
        },
    });

    _mailerCache = {
        transporter,
        tokenExpiresAt: now + 50 * 1000,
    };

    return transporter;
} */
// OAuth karmaşası yerine basit kullanım
async function getMailer() {
    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD, // 16 haneli şifre
        },
    });
    return transporter;
}

module.exports = {
    env,
    mustEnv,
    createSmsHttp,
    getMailer,
};
