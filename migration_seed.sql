-- ============================================================
-- MIGRATION SEED SQL
-- Database: bdb1
-- Purpose: Fresh install için gerekli minimal data
-- ============================================================

-- ----------------------------------------------------------
-- 1. APP_SETTINGS
-- ----------------------------------------------------------
INSERT INTO app_settings (id, settings_json, updated_at)
VALUES (
 1,
    '{"end_hour": "20:30", "start_hour": "09:30", "closed_days": [0], "sms_reminder": true, "no_show_limit": 3, "reminder_hours": 6, "otp_ttl_seconds": 60, "sms_notification": true, "no_show_window_hours": 24, "cancel_deadline_hours": 2, "no_show_grace_minutes": 30, "booking_coming_day_range": 2, "multiple_appointment_count": 8, "scheduler_interval_minutes": 15}',
    NULL
);

-- ----------------------------------------------------------
-- 2. STAFF
-- ----------------------------------------------------------
INSERT INTO staff (id, full_name, phone, image, is_active, created_at, updated_at)
VALUES (1, 'Mustafa Admin', '5467473915', NULL, 1, NULL, NULL);

-- ----------------------------------------------------------
-- 3. SERVICES
-- ----------------------------------------------------------
INSERT INTO services (id, name, duration_minutes, price, is_active, created_at, updated_at)
VALUES
    (1, 'Saç Kesimi', 30, 150, 1, NULL, NULL),
    (2, 'Saç & Sakal', 45, 200, 1, NULL, NULL),
    (3, 'Sakal Kesimi', 20, 100, 1, NULL, NULL),
    (4, 'Cilt Bakımı', 60, 250, 1, NULL, NULL);

-- ----------------------------------------------------------
-- 4. SERVICE_PROVIDERS
-- ----------------------------------------------------------
INSERT INTO service_providers (id, provider_type, code, name, staff_id, capacity, meta_json, is_active, created_at, updated_at)
VALUES (1, 'staff', 'MUSTAFA001', 'Mustafa Admin', 1, 1, '{}', 1, NULL, NULL);

-- ----------------------------------------------------------
-- 5. PROVIDER_SERVICES (Provider-Service Eşleşmeleri)
-- ----------------------------------------------------------
INSERT INTO provider_services (provider_id, service_id)
VALUES
    (1, 1),
    (1, 2),
    (1, 3),
    (1, 4);
