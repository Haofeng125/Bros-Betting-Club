const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');

module.exports = (JWT_SECRET) => {
  const router = express.Router();

  router.post('/login', (req, res) => {
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

  router.get('/me', (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.json({ loggedIn: false });
    try {
      const user = jwt.verify(token, JWT_SECRET);
      const row = db.prepare('SELECT id, username, role, balance, loan_amount, harden_tokens, is_admin FROM users WHERE id = ?').get(user.id);
      res.json({ loggedIn: true, ...row });
    } catch {
      res.json({ loggedIn: false });
    }
  });

  return router;
};
