// router.js
// Tüm tablolar için REST endpointleri burada toplanır.

const express = require("express");
const { AuthControllers, BookingControllers, ScopedControllers } = require("./controllers");
const { sseHandler, desktopSseHandler } = require("./sse");
const { runJobs } = require("./scheduler");

const router = express.Router();


/**
 * AUTH
 */
router.post("/auth/login", AuthControllers.login);
router.post("/auth/verify", AuthControllers.verify);
router.get("/auth/me", AuthControllers.me);
router.post("/auth/logout", AuthControllers.logout);

router.post("/appointments/book", BookingControllers.book);
router.get("/appointments/stream", sseHandler);
router.get("/appointments/test-stream", (req, res) => {
	const { emitAppointment } = require("./sse");
	emitAppointment({ test: true, time: Date.now() });
	res.json({ ok: true, message: "Test event sent" });
});

// Desktop Events SSE (yazıcı komutları için)
router.get("/desktop/events/stream", desktopSseHandler);
router.post("/desktop/events/ack", ScopedControllers.desktopEventAck);
router.post("/desktop/events/action", ScopedControllers.desktopEventAction);
router.get("/desktop/appointments/today", ScopedControllers.desktopAppointmentsToday);
router.get("/desktop/appointments/:id", ScopedControllers.desktopAppointmentById);
router.post("/appointments/can-book", BookingControllers.canBook);
router.post("/appointments/available-slots", BookingControllers.getAvailableSlots);
router.post("/appointments/slots/generate", BookingControllers.generateSlots);
router.post("/appointments/slots/generate/v2", BookingControllers.generateSlotsV2);
router.post("/appointments/success-details", BookingControllers.successDetails);
router.post("/appointments/success-details-all", BookingControllers.successDetailsAll);
router.post("/appointments/cancel", BookingControllers.cancel);
router.get("/appointments/panel", BookingControllers.panelList);
router.post("/appointments/v2/panel", BookingControllers.panelListV2);
router.get("/appointments/panel/:id", BookingControllers.panelGetById);
router.post("/appointments/panel/create", BookingControllers.panelCreate);
router.post("/appointments/panel/create-direct", BookingControllers.panelCreateDirect);
router.post("/appointments/panel/book-quick", BookingControllers.panelBookQuick);
router.post("/appointments/custom", BookingControllers.createCustom);
router.post("/appointments/panel/status", BookingControllers.panelSetStatus);
router.patch("/appointments/:id/status", BookingControllers.updateStatus);
router.put("/appointments/:id", BookingControllers.appointmentUpdate);
router.post("/customers/blacklist", BookingControllers.blacklistCustomer);
router.get("/customers/blacklist", BookingControllers.blacklistList);
router.post("/customers/blacklist/remove", BookingControllers.blacklistRemove);
router.get("/customers/flags/:customerId", BookingControllers.customerFlags);
router.get("/customers/stats", BookingControllers.customerStats);
router.get("/customers", BookingControllers.customerList);
router.post("/appointments/report-month", BookingControllers.reportMonth);
router.post("/appointments/monthly-occupancy", BookingControllers.monthlyOccupancy);
router.post("/appointments/day-details", BookingControllers.dayDetails);
router.post("/appointments/:id/send-reminder", ScopedControllers.sendAppointmentReminder);

// Scoped (read-only / limited) routes
// Not: personal_db.sql tek işletme tabanlı olduğu için:
// - business_id/branch_id gerçek tablolardan değil, app_settings'dan gelen yapay değerler
// - Endpoint isimleri frontend uyumu için eski isimleri koruyor (compat layer)

router.get("/businesses/current", ScopedControllers.businessesCurrent);
router.get("/businesses", ScopedControllers.businessesList);
router.get("/businesses/:id", ScopedControllers.businessesGet);
router.get("/branches/current", ScopedControllers.branchesCurrent);
router.get("/branches/:id", ScopedControllers.branchesGet);
router.get("/staff", ScopedControllers.staffList);
router.get("/services", ScopedControllers.servicesList);
router.get("/services/:id", ScopedControllers.servicesGet);
router.get("/sounds", ScopedControllers.soundsList);
router.get("/sounds/:id", ScopedControllers.soundsGet);

// staff_services -> provider_services (personal_db)
router.get("/provider_services", ScopedControllers.staffServicesList);
router.post("/provider_services/by-provider", ScopedControllers.servicesByProvider);
router.post("/provider_services/assign", ScopedControllers.staffServicesAssign);
router.post("/provider_services/unassign", ScopedControllers.staffServicesUnassign);

// Geriye uyumluluk için eski endpoint isimleri de çalışsın
router.get("/staff_services", ScopedControllers.staffServicesList);
router.post("/staff_services/assign", ScopedControllers.staffServicesAssign);
router.post("/staff_services/unassign", ScopedControllers.staffServicesUnassign);

router.post("/customers", ScopedControllers.customerCreate);
router.put("/customers/:id", ScopedControllers.customerUpdate);
router.delete("/customers/:id", ScopedControllers.customerDelete);
router.get("/appointments", ScopedControllers.appointmentsList);

// closures -> branch_closures (personal_db)
router.get("/closures", ScopedControllers.branchClosuresList);
router.post("/closures", ScopedControllers.branchClosuresCreate);
router.post("/closures/preview", ScopedControllers.branchClosuresPreview);
router.get("/closures/:id", ScopedControllers.branchClosuresGetById);
router.delete("/closures/:id", ScopedControllers.branchClosuresDelete);
router.post("/closures/reopen-today", ScopedControllers.branchClosuresReopenToday);
router.get("/closures/today", ScopedControllers.branchClosuresTodayPublic);

// Geriye uyumluluk için eski isimler de çalışsın
router.get("/branch_closures", ScopedControllers.branchClosuresList);
router.post("/branch_closures", ScopedControllers.branchClosuresCreate);
router.post("/branch_closures/preview", ScopedControllers.branchClosuresPreview);
router.get("/branch_closures/:id", ScopedControllers.branchClosuresGetById);
router.delete("/branch_closures/:id", ScopedControllers.branchClosuresDelete);
router.post("/branch_closures/reopen-today", ScopedControllers.branchClosuresReopenToday);
router.get("/branch_closures/today", ScopedControllers.branchClosuresTodayPublic);

router.put("/businesses/:id/settings", ScopedControllers.businessSettingsUpdate);
router.post("/services", ScopedControllers.servicesCreate);
router.put("/services/:id", ScopedControllers.servicesUpdate);
router.post("/staff", ScopedControllers.staffCreate);
router.put("/staff/:id", ScopedControllers.staffUpdate);

// staff_accounts -> branch_accounts (personal_db)
router.get("/staff_accounts", ScopedControllers.branchAccountsList);
router.post("/staff_accounts", ScopedControllers.branchAccountsCreate);
router.put("/staff_accounts/:id", ScopedControllers.branchAccountsUpdate);
router.delete("/staff_accounts/:id", ScopedControllers.branchAccountsRemove);

// Geriye uyumluluk için eski isimler de çalışsın
router.get("/branch_accounts", ScopedControllers.branchAccountsList);
router.post("/branch_accounts", ScopedControllers.branchAccountsCreate);
router.put("/branch_accounts/:id", ScopedControllers.branchAccountsUpdate);
router.delete("/branch_accounts/:id", ScopedControllers.branchAccountsRemove);

router.delete("/staff/:id", ScopedControllers.staffRemove);

// Service Providers CRUD (personal_db provider system)
router.get("/service_providers", ScopedControllers.providersList);
router.post("/service_providers", ScopedControllers.providersCreate);
router.put("/service_providers/:id", ScopedControllers.providersUpdate);
router.delete("/service_providers/:id", ScopedControllers.providersRemove);

// Period Settings CRUD
router.get("/period_settings", ScopedControllers.periodSettingsList);
router.post("/period_settings", ScopedControllers.periodSettingsCreate);
router.put("/period_settings/:id", ScopedControllers.periodSettingsUpdate);
router.post("/period_settings/:id", ScopedControllers.periodSettingsDelete);
router.post("/period_settings/for-date", ScopedControllers.periodSettingsForDate);
router.post("/period_settings/:id/preview-update", ScopedControllers.periodSettingsPreviewUpdate);

// V2 Slot Engine - provider_break_rules CRUD
router.get("/provider_break_rules", ScopedControllers.providerBreakRulesList);
router.post("/provider_break_rules", ScopedControllers.providerBreakRulesCreate);
router.put("/provider_break_rules/:id", ScopedControllers.providerBreakRulesUpdate);
router.delete("/provider_break_rules/:id", ScopedControllers.providerBreakRulesDelete);
router.get("/provider_break_rules/:id", ScopedControllers.providerBreakRulesGetById);

// V2 Slot Engine - provider_static_slots CRUD
router.get("/provider_static_slots", ScopedControllers.providerStaticSlotsList);
router.post("/provider_static_slots", ScopedControllers.providerStaticSlotsCreate);
router.put("/provider_static_slots/:id", ScopedControllers.providerStaticSlotsUpdate);
router.delete("/provider_static_slots/:id", ScopedControllers.providerStaticSlotsDelete);
router.get("/provider_static_slots/:id", ScopedControllers.providerStaticSlotsGetById);

// V2 Slot Engine - reserved_slots CRUD
router.get("/reserved_slots", ScopedControllers.reservedSlotsList);
router.post("/reserved_slots", ScopedControllers.reservedSlotsCreate);
router.put("/reserved_slots/:id", ScopedControllers.reservedSlotsUpdate);
router.delete("/reserved_slots/:id", ScopedControllers.reservedSlotsDelete);
router.get("/reserved_slots/:id", ScopedControllers.reservedSlotsGetById);
router.post("/reserved_slots/check-conflicts", ScopedControllers.reservedSlotsCheckConflicts);

module.exports = router;