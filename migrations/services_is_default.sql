-- ============================================================
-- Migration: services.is_default
-- Purpose: Add is_default boolean column to services table.
--          Enforces a single default service at the application
--          layer (controllers.js servicesCreate / servicesUpdate).
--          Idempotent: INFORMATION_SCHEMA kontrolü ile tekrar
--          çalıştırılabilir.
-- ============================================================

-- 1) is_default kolonu varsa ekleme (idempotent ALTER).
SET @db_name = DATABASE();
SET @col_exists := (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name
      AND TABLE_NAME   = 'services'
      AND COLUMN_NAME  = 'is_default'
);
SET @ddl := IF(
    @col_exists = 0,
    'ALTER TABLE `services` ADD COLUMN `is_default` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_active`',
    'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) Backfill: hiç default yoksa en düşük id'li servis default olsun.
UPDATE `services`
  SET `is_default` = 1
  WHERE `id` = (
    SELECT id FROM (
      SELECT MIN(id) AS id FROM `services`
    ) AS t
  )
  AND NOT EXISTS (
    SELECT 1 FROM `services` WHERE `is_default` = 1
  );
