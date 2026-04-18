const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { getEffectiveRole, isOnCooldown, setCooldown } = require('../utils');

module.exports = (JWT_SECRET, io) => {
  const router = express.Router();

  function requireAuth(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: '未授权' });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ error: '未授权' });
    }
  }

  function checkRole(userId, requiredRole) {
    const effectiveRole = getEffectiveRole(userId);
    return effectiveRole === requiredRole;
  }

  // ── 种植: pick target ──
  router.post('/:gameId/seed', requireAuth, (req, res) => {
    const gameId = parseInt(req.params.gameId);
    const userId = req.user.id;
    const { targetUserId } = req.body;

    if (!checkRole(userId, '种植'))
      return res.json({ success: false, error: '你的角色不是种植' });

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game || !['open', 'pending'].includes(game.status))
      return res.json({ success: false, error: '当前不在投注阶段' });

    if (targetUserId === userId)
      return res.json({ success: false, error: '不能选择自己' });

    const target = db.prepare('SELECT id, username FROM users WHERE id = ? AND is_admin = 0').get(targetUserId);
    if (!target) return res.json({ success: false, error: '目标玩家不存在' });

    db.prepare(`
      INSERT INTO seed_picks (game_id, seeder_id, target_id)
      VALUES (?, ?, ?)
      ON CONFLICT(game_id, seeder_id) DO UPDATE SET target_id = excluded.target_id
    `).run(gameId, userId, targetUserId);

    res.json({ success: true, targetUsername: target.username });
  });

  // ── 哈登球迷: toggle celebration ──
  router.post('/:gameId/celebrate', requireAuth, (req, res) => {
    const gameId = parseInt(req.params.gameId);
    const userId = req.user.id;

    if (!checkRole(userId, '哈登球迷'))
      return res.json({ success: false, error: '你的角色不是哈登球迷' });

    const user = db.prepare('SELECT harden_tokens FROM users WHERE id = ?').get(userId);
    if (user.harden_tokens < 3)
      return res.json({ success: false, error: `庆典机会不足（当前 ${user.harden_tokens} 次，需要至少 3 次）` });

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game || !['open', 'pending'].includes(game.status))
      return res.json({ success: false, error: '当前不在投注阶段' });

    const existing = db.prepare(`SELECT id FROM game_abilities WHERE game_id = ? AND user_id = ? AND ability = '庆典'`).get(gameId, userId);
    if (existing) {
      db.prepare(`DELETE FROM game_abilities WHERE game_id = ? AND user_id = ? AND ability = '庆典'`).run(gameId, userId);
      return res.json({ success: true, active: false });
    } else {
      db.prepare(`INSERT OR IGNORE INTO game_abilities (game_id, user_id, ability) VALUES (?, ?, '庆典')`).run(gameId, userId);
      return res.json({ success: true, active: true });
    }
  });

  // ── 嘴硬的数学老师: 炸胡 (cancel own bet after close) ──
  router.post('/:gameId/zhahu', requireAuth, (req, res) => {
    const gameId = parseInt(req.params.gameId);
    const userId = req.user.id;

    if (!checkRole(userId, '嘴硬的数学老师'))
      return res.json({ success: false, error: '你的角色不是嘴硬的数学老师' });

    if (isOnCooldown(userId, '炸胡'))
      return res.json({ success: false, error: '技能冷却中，还不能使用炸胡' });

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game || game.status !== 'closed')
      return res.json({ success: false, error: '只能在投注截止后使用炸胡' });

    const bet = db.prepare(`SELECT * FROM bets WHERE game_id = ? AND user_id = ? AND status = 'active'`).get(gameId, userId);
    if (!bet) return res.json({ success: false, error: '你本场没有有效投注' });

    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(bet.amount, userId);
    db.prepare(`UPDATE bets SET status = 'refunded' WHERE id = ?`).run(bet.id);
    setCooldown(userId, '炸胡');

    // Broadcast updated bets
    const allBets = db.prepare(`
      SELECT b.user_id, b.team, b.amount, b.is_hidden, b.status, u.username, u.role
      FROM bets b JOIN users u ON b.user_id = u.id
      WHERE b.game_id = ? AND b.status = 'active'
    `).all(gameId);
    const sumA = allBets.filter(b => b.team === 'A').reduce((s, b) => s + b.amount, 0);
    const sumB = allBets.filter(b => b.team === 'B').reduce((s, b) => s + b.amount, 0);
    const pool = sumA + sumB;
    io.to(`game:${gameId}`).emit('betUpdate', {
      bets: allBets.map(b => ({ ...b, amount: b.is_hidden ? null : b.amount })),
      odds: { sumA, sumB, pool, oddsA: pool > 0 && sumA > 0 ? pool/sumA : null, oddsB: pool > 0 && sumB > 0 ? pool/sumB : null }
    });

    res.json({ success: true, refundAmount: bet.amount });
  });

  // ── 张哥: 撕衣 (cancel another's bet after close) ──
  router.post('/:gameId/shiyi', requireAuth, (req, res) => {
    const gameId = parseInt(req.params.gameId);
    const userId = req.user.id;
    const { targetUserId } = req.body;

    if (!checkRole(userId, '张哥'))
      return res.json({ success: false, error: '你的角色不是张哥' });

    if (isOnCooldown(userId, '撕衣'))
      return res.json({ success: false, error: '技能冷却中，还不能使用撕衣' });

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game || game.status !== 'closed')
      return res.json({ success: false, error: '只能在投注截止后使用撕衣' });

    if (targetUserId === userId)
      return res.json({ success: false, error: '不能撕自己' });

    const targetBet = db.prepare(`SELECT b.*, u.role FROM bets b JOIN users u ON b.user_id = u.id WHERE b.game_id = ? AND b.user_id = ? AND b.status = 'active'`).get(gameId, targetUserId);
    if (!targetBet) return res.json({ success: false, error: '目标玩家本场没有有效投注' });

    // Can't target 操盘老哥 who used their ability
    const targetEffectiveRole = getEffectiveRole(targetUserId);
    if (targetBet.is_hidden && targetEffectiveRole === '操盘老哥')
      return res.json({ success: false, error: '无法对使用了操盘技能的玩家发动撕衣' });

    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(targetBet.amount, targetUserId);
    db.prepare(`UPDATE bets SET status = 'cancelled' WHERE id = ?`).run(targetBet.id);
    setCooldown(userId, '撕衣');

    const target = db.prepare('SELECT username FROM users WHERE id = ?').get(targetUserId);

    // Broadcast
    const allBets = db.prepare(`
      SELECT b.user_id, b.team, b.amount, b.is_hidden, b.status, u.username, u.role
      FROM bets b JOIN users u ON b.user_id = u.id
      WHERE b.game_id = ? AND b.status = 'active'
    `).all(gameId);
    const sumA = allBets.filter(b => b.team === 'A').reduce((s, b) => s + b.amount, 0);
    const sumB = allBets.filter(b => b.team === 'B').reduce((s, b) => s + b.amount, 0);
    const pool = sumA + sumB;
    io.to(`game:${gameId}`).emit('betUpdate', {
      bets: allBets.map(b => ({ ...b, amount: b.is_hidden ? null : b.amount })),
      odds: { sumA, sumB, pool, oddsA: pool > 0 && sumA > 0 ? pool/sumA : null, oddsB: pool > 0 && sumB > 0 ? pool/sumB : null }
    });

    res.json({ success: true, targetUsername: target.username, refundAmount: targetBet.amount });
  });

  // ── Me: bet history ──
  router.get('/me/bets', requireAuth, (req, res) => {
    const userId = req.user.id;
    const bets = db.prepare(`
      SELECT b.team, b.amount, b.status, b.balance_at_bet,
             g.id as game_id, g.team_a, g.team_b, g.winner, g.status as game_status,
             g.deadline, g.created_at
      FROM bets b JOIN games g ON b.game_id = g.id
      WHERE b.user_id = ?
      ORDER BY g.created_at DESC
    `).all(userId);

    const result = bets.map(b => {
      const won = b.game_status === 'settled' && b.team === b.winner;
      const lost = b.game_status === 'settled' && b.team !== b.winner;
      return { ...b, won, lost };
    });

    res.json(result);
  });

  return router;
};
