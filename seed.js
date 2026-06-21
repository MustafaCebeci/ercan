/**
 * Database Seed Script
 * Run: node backend/seed.js
 *
 * NOTE: Re-running will NOT duplicate data (uses existing records if found)
 */

require("dotenv").config();
const { pool, Models } = require("./models");

async function seed() {
    console.log("🚀 Database seeding started...\n");

    try {
        // ===== 1. STAFF (skip if exists) =====
        let staffId;
        const existingStaff = await Models.staff.list();
        const mustafaStaff = existingStaff.find(s => s.phone === "5467473915");

        if (mustafaStaff) {
            staffId = mustafaStaff.id;
            console.log("📝 Staff already exists (ID: ${staffId}), skipping...");
        } else {
            console.log("📝 Creating staff...");
            staffId = await Models.staff.create({
                full_name: "Mustafa Admin",
                phone: "5467473915",
                is_active: 1,
            });
            console.log(`   ✓ Staff created (ID: ${staffId})`);
        }

        // ===== 2. STAFF ACCOUNT (Admin) - skip if exists =====
        const existingAccounts = await Models.staff_accounts.list();
        const hasAccount = existingAccounts.some(a => a.staff_id === staffId);

        if (hasAccount) {
            console.log("📝 Staff account already exists, skipping...");
        } else {
            console.log("📝 Creating staff account (admin)...");
            await Models.staff_accounts.create({
                staff_id: staffId,
                is_admin: 1,
                is_active: 1,
            });
            console.log(`   ✓ Staff account created`);
        }

        // ===== 3. PROVIDER - skip if exists =====
        let providerId;
        const existingProviders = await Models.service_providers.list();
        const mustafaProvider = existingProviders.find(p => p.code === "MUSTAFA001");

        if (mustafaProvider) {
            providerId = mustafaProvider.id;
            console.log(`📝 Provider already exists (ID: ${providerId}), skipping...`);
        } else {
            console.log("📝 Creating provider...");
            providerId = await Models.service_providers.create({
                provider_type: "staff",
                code: "MUSTAFA001",
                name: "Mustafa Admin",
                staff_id: staffId,
                capacity: 1,
                meta_json: JSON.stringify({}),
                is_active: 1,
            });
            console.log(`   ✓ Provider created (ID: ${providerId})`);
        }

        // ===== 4. SERVICES (skip if exists - check by name) =====
        console.log("📝 Creating services...");
        const services = [
            { name: "Saç Kesimi", duration_minutes: 30, price: 150 },
            { name: "Saç & Sakal", duration_minutes: 45, price: 200 },
            { name: "Sakal Kesimi", duration_minutes: 20, price: 100 },
            { name: "Cilt Bakımı", duration_minutes: 60, price: 250 },
        ];

        const existingServices = await Models.services.list();
        const serviceIds = [];

        for (const svc of services) {
            const existing = existingServices.find(s => s.name === svc.name);

            if (existing) {
                serviceIds.push(existing.id);
                console.log(`   → Service already exists: ${svc.name} (ID: ${existing.id})`);
            } else {
                const id = await Models.services.create({
                    name: svc.name,
                    duration_minutes: svc.duration_minutes,
                    price: svc.price,
                    is_active: 1,
                });
                serviceIds.push(id);
                console.log(`   ✓ Service: ${svc.name} (ID: ${id})`);
            }
        }

        // ===== 5. PROVIDER-SERVICES MAPPING - skip if exists =====
        console.log("📝 Creating provider-services mappings...");
        const existingMappings = await Models.provider_services.list();

        for (const serviceId of serviceIds) {
            const mappingExists = existingMappings.some(
                m => m.provider_id === providerId && m.service_id === serviceId
            );

            if (mappingExists) {
                console.log(`   → Mapping already exists: ${providerId} <-> ${serviceId}`);
            } else {
                await Models.provider_services.create({
                    provider_id: providerId,
                    service_id: serviceId,
                });
                console.log(`   ✓ Provider-Service: ${providerId} <-> ${serviceId}`);
            }
        }

        // ===== 6. APP_SETTINGS =====
        console.log("📝 Creating app_settings...");
        const existingSettings = await Models.app_settings.list();

        if (existingSettings.length > 0) {
            console.log("   → App settings already exist, skipping...");
        } else {
            await Models.app_settings.create({
                settings_json: JSON.stringify({
                    end_hour: "20:30",
                    start_hour: "09:30",
                    closed_days: [0],
                    sms_reminder: true,
                    no_show_limit: 3,
                    reminder_hours: 6,
                    otp_ttl_seconds: 60,
                    sms_notification: true,
                    no_show_window_hours: 24,
                    cancel_deadline_hours: 2,
                    no_show_grace_minutes: 30,
                    booking_coming_day_range: 2,
                    multiple_appointment_count: 8,
                    scheduler_interval_minutes: 15,
                }),
            });
            console.log("   ✓ App settings created");
        }

        console.log("\n✅ Database seeding completed successfully!");
        console.log("\n📋 Summary:");
        console.log(`   Staff ID: ${staffId}`);
        console.log(`   Provider ID: ${providerId}`);
        console.log(`   Services: ${serviceIds.join(", ")}`);

    } catch (error) {
        console.error("\n❌ Seeding failed:", error.message);
        throw error;
    } finally {
        await pool.end();
    }
}

seed();