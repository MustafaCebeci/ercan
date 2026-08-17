-- WhatsApp Cloud API - Giden Mesajlar Tablosu
-- Migration for whatsapp_messages table

USE `bdb_ercan_v1`;

CREATE TABLE IF NOT EXISTS `whatsapp_messages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `appointment_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `customer_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `to_phone` VARCHAR(20) NOT NULL,
  `type` ENUM('reminder', 'otp', 'cancellation', 'other') NOT NULL DEFAULT 'other',
  `source` ENUM('cron', 'manual', 'api', 'system') NOT NULL DEFAULT 'system',
  `body` VARCHAR(800) NOT NULL,
  `wa_message_id` VARCHAR(120) NULL DEFAULT NULL COMMENT 'WhatsApp Cloud API message ID',
  `template_name` VARCHAR(100) NULL DEFAULT NULL,
  `status` ENUM('queued', 'sent', 'delivered', 'read', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
  `error_message` VARCHAR(300) NULL DEFAULT NULL,
  `scheduled_at` VARCHAR(60) NOT NULL,
  `sent_at` VARCHAR(60) NULL DEFAULT NULL,
  `created_at` VARCHAR(60) NULL DEFAULT NULL,
  `updated_at` VARCHAR(60) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_wa_queue` (`status`, `scheduled_at`) VISIBLE,
  INDEX `idx_wa_appointment` (`appointment_id`) VISIBLE,
  INDEX `idx_wa_customer` (`customer_id`) VISIBLE,
  INDEX `idx_wa_phone` (`to_phone`) VISIBLE,
  INDEX `idx_wa_wa_id` (`wa_message_id`) VISIBLE,
  CONSTRAINT `fk_wa_msg_appt`
    FOREIGN KEY (`appointment_id`) REFERENCES `bdb_ercan_v1`.`appointments` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_wa_msg_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `bdb_ercan_v1`.`customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
