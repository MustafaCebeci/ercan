const express = require("express");
const path = require("path");
const fs = require("fs");

const router = express.Router();
const viewRoot = path.join(__dirname, "view");

function sendView(res, file) {
    res.sendFile(path.join(viewRoot, file));
}

const routes = {
    "/": "index.html",
    "/login_customer": "login_customer.html",
    "/register": "register.html",
    "/login_barber": "login_barber.html",
    "/bPanel": "bPanel.html",
    "/bPanel/settings": "bPanel/settings.html",
    "/randevu": "randevu.html",
    "/randevu/new": "randevu/new.html",
    "/aydinlatma": "aydinlatma.html",
    "/gizlilik": "gizlilik.html",
};

Object.entries(routes).forEach(([route, file]) => {
    router.get(route, (req, res) => sendView(res, file));
});

router.use((req, res) => {
    const reqPath = (req.path || "/").replace(/\/+$/, "");
    if (reqPath && reqPath !== "/") {
        const candidate = path.join(viewRoot, `${reqPath}.html`);
        if (fs.existsSync(candidate)) {
            return res.sendFile(candidate);
        }
    }

    const fallback = path.join(viewRoot, "200.html");
    if (fs.existsSync(fallback)) {
        return res.sendFile(fallback);
    }
    return res.status(404).send("Not found");
});

module.exports = router;
