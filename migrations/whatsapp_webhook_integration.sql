-- WhatsApp Cloud API Webhook Entegrasyonu
-- Migration: incoming_whatsapp_messages tablosu

USE `bdb_ercan_v1`;

-- =====================================================
-- Table: incoming_whatsapp_messages
-- Amaç: Meta WhatsApp webhook'larından gelen payload'ları loglamak
-- =====================================================
CREATE TABLE IF NOT EXISTS `incoming_whatsapp_messages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `message_id` VARCHAR(120) NOT NULL COMMENT 'WhatsApp message ID (idempotency key)',
  `phone` VARCHAR(20) NOT NULL COMMENT 'Gönderen telefon numarası',
  `from_name` VARCHAR(200) NULL DEFAULT NULL COMMENT 'Gönderen WhatsApp display name',
  `app_id` VARCHAR(60) NULL DEFAULT NULL COMMENT 'WhatsApp Business App ID',
  `payload` JSON NOT NULL COMMENT 'Full webhook payload for debugging',
  `processed` TINYINT(1) NOT NULL DEFAULT '0' COMMENT '0=henüz işlenmedi, 1=işlendi',
  `processed_at` VARCHAR(60) NULL DEFAULT NULL COMMENT 'İşlenme zamanı',
  `created_at` VARCHAR(60) NULL DEFAULT NULL COMMENT 'Webhook alınma zamanı',
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_incoming_wa_msg_id` (`message_id` ASC) VISIBLE,
  INDEX `idx_incoming_wa_phone` (`phone` ASC) VISIBLE,
  INDEX `idx_incoming_wa_processed` (`processed` ASC) VISIBLE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
