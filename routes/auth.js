const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');

module.exports = (JWT_SECRET, loginLimiter) => {
  const router = express.Router();

  const REFERRAL_CODE = '302';

  router.post('/register', loginLimiter, (req, res) => {
    const { username, password, referral } = req.body;
    if (!username || !password || !referral)
      return res.json({ success: false, error: '请填写所有字段' });
    if (referral !== REFERRAL_CODE)
      return res.json({ success: false, error: '邀请码错误' });
    if (username.length < 2 || username.length > 16)
      return res.json({ success: false, error: '用户名长度须在 2–16 个字符之间' });
    if (password.length < 6)
      return res.json({ success: false, error: '密码至少 6 位' });

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing)
      return res.json({ success: false, error: '用户名已被使用' });

    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
    res.json({ success: true });
  });

  router.post('/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
      return res.json({ success: false, error: '请输入用户名和密码' });

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user)
      return res.json({ success: false, error: '用户名或密码错误' });

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid)
      return res.json({ success: false, error: '用户名或密码错误' });

    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: user.is_admin === 1 },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, isAdmin: user.is_admin === 1 });
  });

  router.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
  });

  router.post('/change-password', (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    let userId;
    try { userId = jwt.verify(token, JWT_SECRET).id; } catch { return res.status(401).json({ error: 'Unauthorized' }); }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.json({ success: false, error: '请填写所有字段' });
    if (newPassword.length < 6)
      return res.json({ success: false, error: '新密码至少 6 位' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!bcrypt.compareSync(currentPassword, user.password))
      return res.json({ success: false, error: '当前密码错误' });

    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, userId);
    res.json({ success: true });
  });

  router.get('/leaderboard', (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try { jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Unauthorized' }); }

    const users = db.prepare(`
      SELECT u.id, u.username, u.balance, u.loan_amount, u.weekly_profit,
             u.balance + COALESCE(SUM(
               CASE WHEN b.status = 'active' AND g.status NOT IN ('settled','voided') THEN b.amount ELSE 0 END
             ), 0) - u.loan_amount AS total_wealth
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id
      LEFT JOIN games g ON b.game_id = g.id
      GROUP BY u.id
    `).all();

    const winRateUsers = db.prepare(`
      SELECT u.id, u.username,
        COUNT(CASE WHEN b.status = 'active' AND g.status = 'settled' THEN 1 END) AS total_bets,
        COUNT(CASE WHEN b.status = 'active' AND g.status = 'settled' AND b.team = g.winner THEN 1 END) AS wins
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id
      LEFT JOIN games g ON b.game_id = g.id
      GROUP BY u.id
    `).all();

    const collator = new Intl.Collator('zh-CN', { sensitivity: 'base' });
    const tieBreak = (a, b) => collator.compare(a.username[0] || '', b.username[0] || '');

    const byBalance  = [...users].sort((a, b) => b.balance !== a.balance ? b.balance - a.balance : tieBreak(a, b));
    const byWealth   = [...users].sort((a, b) => b.total_wealth !== a.total_wealth ? b.total_wealth - a.total_wealth : tieBreak(a, b));
    const byWeekly   = [...users].sort((a, b) => b.weekly_profit !== a.weekly_profit ? b.weekly_profit - a.weekly_profit : tieBreak(a, b));
    const byWinRate  = [...winRateUsers].sort((a, b) => {
      const rA = a.total_bets > 0 ? a.wins / a.total_bets : -1;
      const rB = b.total_bets > 0 ? b.wins / b.total_bets : -1;
      if (rA !== rB) return rB - rA;
      if (a.total_bets !== b.total_bets) return b.total_bets - a.total_bets;
      return tieBreak(a, b);
    });

    res.json({ byBalance, byWealth, byWeekly, byWinRate });
  });

  router.get('/me', (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.json({ loggedIn: false });
    try {
      const user = jwt.verify(token, JWT_SECRET);
      const row = db.prepare('SELECT id, username, balance, loan_amount, is_admin FROM users WHERE id = ?').get(user.id);
      const pendingRow = db.prepare(`
        SELECT COALESCE(SUM(b.amount), 0) AS total
        FROM bets b JOIN games g ON b.game_id = g.id
        WHERE b.user_id = ? AND b.status = 'active' AND g.status NOT IN ('settled', 'voided')
      `).get(user.id);
      const pending_bets = pendingRow.total;
      const total_assets = row.balance + pending_bets - row.loan_amount;
      res.json({ loggedIn: true, ...row, pending_bets, total_assets });
    } catch {
      res.json({ loggedIn: false });
    }
  });

  return router;
};
