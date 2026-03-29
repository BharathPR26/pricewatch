-- ============================================================
-- PriceWatch v2 — Complete Database Schema
-- MySQL 8.0+
-- ============================================================

CREATE DATABASE IF NOT EXISTS pricewatch;
USE pricewatch;

-- ─── USERS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  user_id        INT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(100)  NOT NULL,
  email          VARCHAR(150)  NOT NULL UNIQUE,
  password       VARCHAR(255)  NOT NULL,
  notify_email   BOOLEAN       DEFAULT TRUE,
  created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);

-- ─── PRODUCTS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  product_id   INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(255)  NOT NULL,
  url          TEXT          NOT NULL,
  category     ENUM('Electronics','Fashion','Books','Food','Home','Other') DEFAULT 'Other',
  image_url    TEXT,
  added_by     INT           NOT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (added_by) REFERENCES users(user_id) ON DELETE CASCADE
);

-- ─── PRICE HISTORY ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
  ph_id        INT AUTO_INCREMENT PRIMARY KEY,
  product_id   INT           NOT NULL,
  price        DECIMAL(10,2) NOT NULL,
  recorded_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

-- ─── WATCHLIST ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlist (
  watch_id      INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT           NOT NULL,
  product_id    INT           NOT NULL,
  target_price  DECIMAL(10,2) NOT NULL,
  is_active     BOOLEAN       DEFAULT TRUE,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_watch (user_id, product_id),
  FOREIGN KEY (user_id)    REFERENCES users(user_id)    ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

-- ─── ALERTS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  alert_id        INT AUTO_INCREMENT PRIMARY KEY,
  watch_id        INT           NOT NULL,
  triggered_price DECIMAL(10,2) NOT NULL,
  triggered_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  is_read         BOOLEAN       DEFAULT FALSE,
  email_sent      BOOLEAN       DEFAULT FALSE,
  FOREIGN KEY (watch_id) REFERENCES watchlist(watch_id) ON DELETE CASCADE
);

-- ─── TRIGGER: Auto-alert when price hits target ──────────────
DELIMITER //
CREATE TRIGGER IF NOT EXISTS check_price_alert
AFTER INSERT ON price_history
FOR EACH ROW
BEGIN
  INSERT INTO alerts (watch_id, triggered_price, triggered_at)
  SELECT w.watch_id, NEW.price, NOW()
  FROM   watchlist w
  WHERE  w.product_id   = NEW.product_id
    AND  w.target_price >= NEW.price
    AND  w.is_active    = TRUE;
END; //
DELIMITER ;

-- ─── INDEXES ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ph_product  ON price_history(product_id);
CREATE INDEX IF NOT EXISTS idx_ph_time     ON price_history(recorded_at);
CREATE INDEX IF NOT EXISTS idx_wl_user     ON watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_alert_watch ON alerts(watch_id);
CREATE INDEX IF NOT EXISTS idx_alert_email ON alerts(email_sent);

-- ─── SEED DATA ───────────────────────────────────────────────
INSERT INTO users (name, email, password, notify_email) VALUES
  ('Demo User', 'demo@pricewatch.com',
   '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', TRUE);

INSERT INTO products (name, url, category, image_url, added_by) VALUES
  ('Sony WH-1000XM5 Headphones','https://amazon.in/sony-wh1000xm5','Electronics',
   'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400',1),
  ('Nike Air Max 270','https://flipkart.com/nike-airmax-270','Fashion',
   'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400',1),
  ('Atomic Habits — James Clear','https://amazon.in/atomic-habits','Books',
   'https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=400',1);

INSERT INTO price_history (product_id, price, recorded_at) VALUES
  (1,29990.00,DATE_SUB(NOW(),INTERVAL 30 DAY)),
  (1,28500.00,DATE_SUB(NOW(),INTERVAL 25 DAY)),
  (1,27999.00,DATE_SUB(NOW(),INTERVAL 20 DAY)),
  (1,26500.00,DATE_SUB(NOW(),INTERVAL 15 DAY)),
  (1,24990.00,DATE_SUB(NOW(),INTERVAL 10 DAY)),
  (1,23499.00,DATE_SUB(NOW(),INTERVAL 5 DAY)),
  (1,21999.00,NOW()),
  (2,8995.00,DATE_SUB(NOW(),INTERVAL 20 DAY)),
  (2,8495.00,DATE_SUB(NOW(),INTERVAL 14 DAY)),
  (2,7999.00,DATE_SUB(NOW(),INTERVAL 7 DAY)),
  (2,7499.00,NOW()),
  (3,499.00,DATE_SUB(NOW(),INTERVAL 15 DAY)),
  (3,449.00,DATE_SUB(NOW(),INTERVAL 8 DAY)),
  (3,399.00,NOW());

INSERT INTO watchlist (user_id, product_id, target_price) VALUES
  (1,1,22000.00),(1,2,7500.00),(1,3,400.00);