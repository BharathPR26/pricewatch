const express  = require('express');
const cors     = require('cors');
const session  = require('express-session');
const path     = require('path');
const cron     = require('node-cron');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const db                      = require('./db');
const { sendPriceAlertEmail } = require('./mailer');
const { scrapeProduct }       = require('./scraper');
const authRoutes              = require('./routes/auth');
const productRoutes           = require('./routes/products');
const watchRoutes             = require('./routes/watchlist');
const alertRoutes             = require('./routes/alerts');
const scrapeRoutes            = require('./routes/scrape');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked'));
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'pricewatch_dev_secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    maxAge:   1000 * 60 * 60 * 24 * 7,
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
  },
}));

// ── Static frontend ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// ── API routes ─────────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/products',  productRoutes);
app.use('/api/watchlist', watchRoutes);
app.use('/api/alerts',    alertRoutes);
app.use('/api/scrape',    scrapeRoutes);
app.get('/api/health',    (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── SPA fallback ───────────────────────────────────────────────
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '../frontend/index.html')));

// ══════════════════════════════════════════════════════════════
// CRON 1 — Auto price check every 6 hours
// Visits every product URL, scrapes the latest price,
// saves it to price_history → SQL trigger fires alerts
// ══════════════════════════════════════════════════════════════
async function runAutoScrape() {
  console.log('\n[AutoScrape] Starting scheduled price check...');
  try {
    const [products] = await db.query(`
      SELECT DISTINCT p.product_id, p.name, p.url,
        p.image_url, p.category,
        (SELECT ph.price FROM price_history ph
         WHERE ph.product_id = p.product_id
         ORDER BY ph.recorded_at DESC LIMIT 1) AS last_price
      FROM products p
      JOIN watchlist w ON w.product_id = p.product_id
      WHERE w.is_active = TRUE
    `);

    if (!products.length) {
      console.log('[AutoScrape] No watched products found.');
      return;
    }

    console.log(`[AutoScrape] Checking ${products.length} product(s)...`);
    let updated = 0;
    let unchanged = 0;
    let failed = 0;

    for (const product of products) {
      try {
        const result = await scrapeProduct(product.url);

        if (!result.success || !result.price) {
          console.log(`[AutoScrape] ✗ No price for: ${product.name}`);
          failed++;
          continue;
        }

        // Only save if price actually changed (avoid duplicate entries)
        const newPrice  = parseFloat(result.price);
        const lastPrice = parseFloat(product.last_price);

        if (lastPrice && Math.abs(newPrice - lastPrice) < 0.01) {
          console.log(`[AutoScrape] = Unchanged ₹${newPrice} for: ${product.name}`);
          unchanged++;
          continue;
        }

        // Insert new price → SQL trigger fires automatically
        await db.query(
          'INSERT INTO price_history (product_id, price) VALUES (?, ?)',
          [product.product_id, newPrice]
        );

        const change = lastPrice
          ? (newPrice < lastPrice ? `↓ dropped ₹${(lastPrice - newPrice).toFixed(0)}` : `↑ rose ₹${(newPrice - lastPrice).toFixed(0)}`)
          : 'first check';

        console.log(`[AutoScrape] ✓ ${product.name}: ₹${newPrice} (${change})`);
        updated++;

        // Small delay between requests to avoid being blocked
        await new Promise(r => setTimeout(r, 3000));
      } catch (err) {
        console.log(`[AutoScrape] ✗ Error for ${product.name}: ${err.message}`);
        failed++;
      }
    }

    console.log(`[AutoScrape] Done — Updated: ${updated}, Unchanged: ${unchanged}, Failed: ${failed}\n`);

    // After scraping, send any new unsent emails
    await sendPendingEmails();

  } catch (err) {
    console.error('[AutoScrape] Fatal error:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// CRON 2 — Send pending email alerts every 10 minutes
// ══════════════════════════════════════════════════════════════
async function sendPendingEmails() {
  try {
    const [pending] = await db.query(`
      SELECT a.alert_id, a.triggered_price, w.target_price,
        p.name AS product_name, p.url, p.image_url, p.category,
        u.email AS user_email, u.name AS user_name, u.notify_email,
        (SELECT MIN(ph.price) FROM price_history ph WHERE ph.product_id = p.product_id) AS all_time_low,
        (SELECT ph2.price FROM price_history ph2 WHERE ph2.product_id = p.product_id
         ORDER BY ph2.recorded_at ASC LIMIT 1) AS first_price
      FROM alerts a
      JOIN watchlist w ON w.watch_id   = a.watch_id
      JOIN products  p ON p.product_id = w.product_id
      JOIN users     u ON u.user_id    = w.user_id
      WHERE a.email_sent = FALSE AND u.notify_email = TRUE
      LIMIT 20
    `);

    for (const alert of pending) {
      const dropPct = alert.first_price > 0
        ? ((alert.first_price - alert.triggered_price) / alert.first_price * 100).toFixed(1)
        : '0';
      const sent = await sendPriceAlertEmail({
        toEmail:      alert.user_email,
        userName:     alert.user_name,
        productName:  alert.product_name,
        productUrl:   alert.url,
        productImage: alert.image_url,
        currentPrice: alert.triggered_price,
        targetPrice:  alert.target_price,
        allTimeLow:   alert.all_time_low,
        dropPct,
        category:     alert.category,
      });
      if (sent) {
        await db.query('UPDATE alerts SET email_sent = TRUE WHERE alert_id = ?', [alert.alert_id]);
        console.log(`[Email] ✓ Sent to ${alert.user_email} for ${alert.product_name}`);
      }
    }
  } catch (err) {
    console.error('[Email] Error sending pending alerts:', err.message);
  }
}

// Schedule: auto scrape every 6 hours
cron.schedule('0 */6 * * *', runAutoScrape);

// Schedule: email retry every 10 minutes
cron.schedule('*/10 * * * *', sendPendingEmails);

// Run once immediately on server start (after 30s delay)
setTimeout(() => {
  console.log('[AutoScrape] Running initial price check in background...');
  runAutoScrape();
}, 30000);

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🔔 PriceWatch v2 → http://localhost:${PORT}`);
  console.log(`   DB    : ${process.env.DB_NAME || 'pricewatch'} @ ${process.env.DB_HOST || 'localhost'}`);
  console.log(`   Email : ${process.env.GMAIL_USER || 'not configured'}`);
  console.log(`   Auto  : Price check every 6 hours + email retry every 10 min\n`);
});