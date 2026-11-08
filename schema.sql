-- Table for Baileys Multi-Device Auth State (creds + signal keys)
CREATE TABLE IF NOT EXISTS `wa_gw_auth` (
  `session_key` VARCHAR(128) NOT NULL,
  `key_name` VARCHAR(191) NOT NULL,
  `value` LONGTEXT NOT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`session_key`, `key_name`),
  INDEX `idx_session_key` (`session_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table for Message Status Mapping (message_id -> client_ref) to survive restarts
CREATE TABLE IF NOT EXISTS `wa_gw_msgmap` (
  `message_id` VARCHAR(191) NOT NULL,
  `session_key` VARCHAR(128) NOT NULL,
  `client_ref` VARCHAR(191) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`message_id`),
  INDEX `idx_session_msg` (`session_key`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
