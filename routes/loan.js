const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../database');

module.exports = (JWT_SECRET) => {
  const router = express.Router();

  function requireAuth(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // GET current loan status
  router.get('/status', requireAuth, (req, res) => {
    const user = db.prepare('SELECT balance, loan_amount FROM users WHERE id = ?').get(req.user.id);
    const pendingRow = db.prepare(`
      SELECT COALESCE(SUM(b.amount), 0) AS total
      FROM bets b JOIN games g ON b.game_id = g.id
      WHERE b.user_id = ? AND b.status = 'active' AND g.status NOT IN ('settled', 'voided')
    `).get(req.user.id);
    const effective_balance = user.balance + pendingRow.total;
    res.json({ ...user, pending_bets: pendingRow.total, effective_balance });
  });

  // POST borrow 5000 — only allowed if balance + pending bets < 100
  router.post('/borrow', requireAuth, (req, res) => {
    const user = db.prepare('SELECT balance, loan_amount FROM users WHERE id = ?').get(req.user.id);
    const pending = db.prepare(`
      SELECT COALESCE(SUM(b.amount), 0) as total
      FROM bets b JOIN games g ON b.game_id = g.id
      WHERE b.user_id = ? AND b.status = 'active' AND g.status NOT IN ('settled', 'voided')
    `).get(req.user.id);
    const effectiveBalance = user.balance + pending.total;

    if (effectiveBalance >= 100)
      return res.json({ success: false, error: '余额不低于 ¥100，暂不符合借款条件' });

    db.prepare('UPDATE users SET balance = balance + 5000, loan_amount = loan_amount + 5000 WHERE id = ?').run(req.user.id);
    const updated = db.prepare('SELECT balance, loan_amount FROM users WHERE id = ?').get(req.user.id);
    res.json({ success: true, balance: updated.balance, loan_amount: updated.loan_amount });
  });

  // POST repay — deduct from balance, reduce loan_amount
  router.post('/repay', requireAuth, (req, res) => {
    const amt = parseInt(req.body.amount);
    if (!amt || amt <= 0)
      return res.json({ success: false, error: '请输入有效金额' });

    const user = db.prepare('SELECT balance, loan_amount FROM users WHERE id = ?').get(req.user.id);

    if (user.loan_amount === 0)
      return res.json({ success: false, error: '你没有未还债务' });
    if (amt > user.balance)
      return res.json({ success: false, error: `余额不足（当前余额 ¥${user.balance.toLocaleString()}）` });
    if (amt > user.loan_amount)
      return res.json({ success: false, error: `还款金额不可超过欠款 ¥${user.loan_amount.toLocaleString()}` });

    db.prepare('UPDATE users SET balance = balance - ?, loan_amount = loan_amount - ? WHERE id = ?').run(amt, amt, req.user.id);
    const updated = db.prepare('SELECT balance, loan_amount FROM users WHERE id = ?').get(req.user.id);
    res.json({ success: true, balance: updated.balance, loan_amount: updated.loan_amount });
  });

  return router;
};
