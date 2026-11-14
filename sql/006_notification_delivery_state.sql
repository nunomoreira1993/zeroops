CREATE TABLE IF NOT EXISTS notification_delivery_state (
  outbox_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  state VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'sent', 'blocked', 'failed', 'uncertain')),
  attempts INT NOT NULL DEFAULT 0,
  lease_id CHAR(36) CHARACTER SET ascii NULL,
  claimed_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  error_code VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY notification_delivery_queue (state, created_at),
  CONSTRAINT notification_delivery_outbox_fk
    FOREIGN KEY (outbox_id) REFERENCES notification_outbox(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO notification_delivery_state(outbox_id,state,error_code,finished_at)
SELECT id,
       CASE status
         WHEN 'sent' THEN 'sent'
         WHEN 'blocked' THEN 'blocked'
         WHEN 'failed' THEN 'failed'
         ELSE 'pending'
       END,
       error_code,
       CASE WHEN status='pending' THEN NULL ELSE created_at END
FROM notification_outbox;
