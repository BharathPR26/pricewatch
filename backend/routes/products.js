const express             = require('express');
const db                  = require('../db');
const { requireAuth }     = require('../middleware/auth');
const { sendPriceAlertEmail } = require('../mailer');
const router              = express.Router();

// GET /api/products
router.get('/', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT p.product_id, p.name, p.url, p.category, p.image_url, p.created_at,
        (SELECT ph.price FROM price_history ph WHERE ph.product_id=p.product_id
         ORDER BY ph.recorded_at DESC LIMIT 1) AS current_price,
        (SELECT ph2.price FROM price_history ph2 WHERE ph2.product_id=p.product_id
         ORDER BY ph2.recorded_at ASC LIMIT 1) AS first_price,
        MIN(ph3.price) AS all_time_low,
        COUNT(ph3.ph_id) AS price_entries
      FROM products p
      LEFT JOIN price_history ph3 ON ph3.product_id = p.product_id
      WHERE p.added_by = ?
      GROUP BY p.product_id
      ORDER BY p.created_at DESC
    `, [req.session.user.user_id]);
    res.json({ products: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch products.' });
  }
});

// GET /api/products/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [prod] = await db.query(
      'SELECT * FROM products WHERE product_id=? AND added_by=?',
      [req.params.id, req.session.user.user_id]
    );
    if (!prod.length) return res.status(404).json({ error: 'Product not found.' });

    const [history] = await db.query(
      'SELECT price, recorded_at FROM price_history WHERE product_id=? ORDER BY recorded_at ASC',
      [req.params.id]
    );
    const [watchInfo] = await db.query(`
      SELECT w.*,
        (SELECT MIN(ph.price) FROM price_history ph WHERE ph.product_id=w.product_id) AS all_time_low,
        (SELECT ph2.price FROM price_history ph2 WHERE ph2.product_id=w.product_id
         ORDER BY ph2.recorded_at DESC LIMIT 1) AS current_price
      FROM watchlist w WHERE w.user_id=? AND w.product_id=?
    `, [req.session.user.user_id, req.params.id]);

    res.json({ product: prod[0], history, watchInfo: watchInfo[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product.' });
  }
});

// POST /api/products
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, url, category, image_url, initial_price } = req.body;
    if (!name || !url || !initial_price)
      return res.status(400).json({ error: 'Name, URL, and price are required.' });

    const [result] = await db.query(
      'INSERT INTO products (name,url,category,image_url,added_by) VALUES (?,?,?,?,?)',
      [name, url, category || 'Other', image_url || null, req.session.user.user_id]
    );
    await db.query('INSERT INTO price_history (product_id,price) VALUES (?,?)',
      [result.insertId, initial_price]);

    res.json({ message: 'Product added.', product_id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add product.' });
  }
});

// POST /api/products/:id/price  ← fires TRIGGER + sends email
router.post('/:id/price', requireAuth, async (req, res) => {
  try {
    const { price } = req.body;
    if (!price || isNaN(price))
      return res.status(400).json({ error: 'Valid price required.' });

    const [prod] = await db.query(
      'SELECT product_id FROM products WHERE product_id=? AND added_by=?',
      [req.params.id, req.session.user.user_id]
    );
    if (!prod.length) return res.status(404).json({ error: 'Product not found.' });

    // This INSERT fires the SQL TRIGGER automatically
    await db.query('INSERT INTO price_history (product_id,price) VALUES (?,?)',
      [req.params.id, price]);

    // Find any new unsent alerts and dispatch emails
    const [newAlerts] = await db.query(`
      SELECT a.alert_id, a.triggered_price, a.watch_id,
        w.target_price, w.user_id,
        p.name AS product_name, p.url, p.image_url, p.category,
        u.email AS user_email, u.name AS user_name, u.notify_email,
        (SELECT MIN(ph.price) FROM price_history ph WHERE ph.product_id=p.product_id) AS all_time_low,
        (SELECT ph2.price FROM price_history ph2 WHERE ph2.product_id=p.product_id
         ORDER BY ph2.recorded_at ASC LIMIT 1) AS first_price
      FROM alerts a
      JOIN watchlist w  ON w.watch_id   = a.watch_id
      JOIN products  p  ON p.product_id = w.product_id
      JOIN users     u  ON u.user_id    = w.user_id
      WHERE p.product_id = ? AND a.email_sent = FALSE
      ORDER BY a.triggered_at DESC
    `, [req.params.id]);

    // Send emails asynchronously (don't block response)
    for (const alert of newAlerts) {
      if (!alert.notify_email) continue;
      const dropPct = alert.first_price > 0
        ? ((alert.first_price - alert.triggered_price) / alert.first_price * 100).toFixed(1)
        : '0';

      sendPriceAlertEmail({
        toEmail:       alert.user_email,
        userName:      alert.user_name,
        productName:   alert.product_name,
        productUrl:    alert.url,
        productImage:  alert.image_url,
        currentPrice:  alert.triggered_price,
        targetPrice:   alert.target_price,
        allTimeLow:    alert.all_time_low,
        dropPct,
        category:      alert.category,
      }).then(sent => {
        if (sent) db.query('UPDATE alerts SET email_sent=TRUE WHERE alert_id=?', [alert.alert_id]);
      });
    }

    res.json({
      message: 'Price updated.',
      alerts_triggered: newAlerts.length,
      emails_dispatched: newAlerts.filter(a => a.notify_email).length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update price.' });
  }
});

// DELETE /api/products/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM products WHERE product_id=? AND added_by=?',
      [req.params.id, req.session.user.user_id]);
    res.json({ message: 'Product deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product.' });
  }
});

// PUT /api/products/:id  — edit product name/category/image
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, category, image_url } = req.body;
    await db.query(
      'UPDATE products SET name=?, category=?, image_url=? WHERE product_id=? AND added_by=?',
      [name, category, image_url, req.params.id, req.session.user.user_id]
    );
    res.json({ message: 'Product updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product.' });
  }
});

module.exports = router;