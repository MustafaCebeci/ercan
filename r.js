// router.js
const express = require("express");
const { Controllers, AuthControllers } = require("./controllers");

const router = express.Router();

/**
 * AUTH
 */
router.post("/auth/login", AuthControllers.login);
router.post("/auth/verify", AuthControllers.verify);
router.get("/auth/me", AuthControllers.me);
router.post("/auth/logout", AuthControllers.logout);

/**
 * Standart CRUD route mount
 * - Normal tablolar: /table, /table/:id
 * - Composite PK: /staff_services/:business_id/:staff_id/:service_id
 * - business_settings PK: /business_settings/:business_id
 */
function mountCrud(base, c, opts = {}) {
  const pkPath = opts.pkPath || "/:id";

  router.get(`/${base}`, c.list);
  router.post(`/${base}`, c.create);
  router.get(`/${base}${pkPath}`, c.get);
  router.put(`/${base}${pkPath}`, c.update);
  router.delete(`/${base}${pkPath}`, c.remove);
}

// Normal tablolar
mountCrud("businesses", Controllers.businesses);
mountCrud("branches", Controllers.branches);
mountCrud("staff", Controllers.staff);
mountCrud("services", Controllers.services);
mountCrud("customers", Controllers.customers);
mountCrud("customer_business_flags", Controllers.customer_business_flags);
mountCrud("appointments", Controllers.appointments);
mountCrud("appointment_slots", Controllers.appointment_slots);
mountCrud("sms_messages", Controllers.sms_messages);
mountCrud("appointment_status_history", Controllers.appointment_status_history);
mountCrud("branch_accounts", Controllers.branch_accounts);
mountCrud("otp_codes", Controllers.otp_codes);

// Composite PK
mountCrud("staff_services", Controllers.staff_services, {
  pkPath: "/:business_id/:staff_id/:service_id",
});

// PK = business_id
mountCrud("business_settings", Controllers.business_settings, {
  pkPath: "/:business_id",
});

module.exports = router;
