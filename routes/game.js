const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../database');

function fetchBets(gameId) {
  return db.prepare(`
    SELECT b.user_id, b.team, b.amount, b.status, b.payout, b.recovery, u.username
    FROM bets b JOIN users u ON b.user_id = u.id
    WHERE b.game_id = ? AND b.status = 'active'
  `).all(gameId);
}

function calcTotals(bets) {
  const sumA = bets.filter(b => b.team === 'A').reduce((s, b) => s + b.amount, 0);
  const sumB = bets.filter(b => b.team === 'B').reduce((s, b) => s + b.amount, 0);
  return { sumA, sumB, pool: sumA + sumB };
}

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

  // Active games for lobby
  router.get('/', requireAuth, (req, res) => {
    const games = db.prepare(`
      SELECT * FROM games WHERE status IN ('open', 'pending') ORDER BY deadline ASC
    `).all();
    res.json(games);
  });

  // Past games for history tab
  router.get('/history', requireAuth, (req, res) => {
    const games = db.prepare(`
      SELECT * FROM games WHERE status IN ('settled', 'voided', 'closed')
      ORDER BY created_at DESC LIMIT 30
    `).all();
    res.json(games);
  });

  // Full results for a settled/closed game
  router.get('/:id/results', requireAuth, (req, res) => {
    const gameId = parseInt(req.params.id);
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) return res.status(404).json({ error: '比赛不存在' });

    const allBets = db.prepare(`
      SELECT b.user_id, b.team, b.amount, b.status, b.payout, b.recovery, u.username
      FROM bets b JOIN users u ON b.user_id = u.id
      WHERE b.game_id = ?
    `).all(gameId);

    const activeBets = allBets.filter(b => b.status === 'active');
    const refundedBets = allBets.filter(b => b.status === 'refunded');

    const sumA = activeBets.filter(b => b.team === 'A').reduce((s, b) => s + b.amount, 0);
    const sumB = activeBets.filter(b => b.team === 'B').reduce((s, b) => s + b.amount, 0);
    const pool = sumA + sumB;

    const results = activeBets.map(b => {
      const won = game.status === 'settled' && b.team === game.winner;
      const odds = b.team === 'A' ? game.odds_a : game.odds_b;
      // Use stored payout/recovery if available, fall back to base odds for legacy bets
      const payout = won ? (b.payout > 0 ? b.payout : Math.floor(b.amount * odds)) : 0;
      const recovery = won ? 0 : (b.recovery || 0);
      const profit = won ? payout - b.amount : -(b.amount - recovery);
      return { ...b, won, payout, recovery, profit };
    });

    res.json({ game, results, refundedBets, sumA, sumB, pool, oddsA: game.odds_a, oddsB: game.odds_b });
  });

  // Single game info (live betting view)
  router.get('/:id', requireAuth, (req, res) => {
    const gameId = parseInt(req.params.id);
    const userId = req.user.id;
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) return res.status(404).json({ error: '比赛不存在' });

    const bets = fetchBets(gameId);
    const totals = calcTotals(bets);
    const myBet = bets.find(b => b.user_id === userId) || null;

    res.json({ game, bets, totals, myBet });
  });

  // My full bet history (for /me page)
  router.get('/me/bets', requireAuth, (req, res) => {
    const userId = req.user.id;
    const bets = db.prepare(`
      SELECT b.id, b.game_id, b.team, b.amount, b.status,
             g.team_a, g.team_b, g.status as game_status, g.winner, g.deadline,
             CASE WHEN g.status = 'settled' AND b.team = g.winner AND b.status = 'active' THEN 1 ELSE 0 END as won,
             CASE WHEN g.status = 'settled' AND b.team != g.winner AND b.status = 'active' THEN 1 ELSE 0 END as lost
      FROM bets b JOIN games g ON b.game_id = g.id
      WHERE b.user_id = ?
      ORDER BY g.created_at DESC
    `).all(userId);
    res.json(bets);
  });

  // Place bet
  router.post('/:id/bet', requireAuth, (req, res) => {
    const gameId = parseInt(req.params.id);
    const userId = req.user.id;
    const { team, amount } = req.body;

    if (!['A', 'B'].includes(team))
      return res.json({ success: false, error: '请选择投注队伍' });

    const amt = parseInt(amount);
    if (!amt || amt <= 0)
      return res.json({ success: false, error: '请输入有效投注金额' });

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) return res.json({ success: false, error: '比赛不存在' });
    if (!['open', 'pending'].includes(game.status)) return res.json({ success: false, error: '当前不在投注阶段' });
    if (new Date(game.deadline) <= new Date()) return res.json({ success: false, error: '投注已截止' });

    const existing = db.prepare('SELECT id FROM bets WHERE game_id = ? AND user_id = ?').get(gameId, userId);
    if (existing) return res.json({ success: false, error: '你本场已经投注过了' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (user.balance < amt)
      return res.json({ success: false, error: `余额不足（当前余额 ¥${user.balance.toLocaleString()}）` });

    if (user.loan_amount > 0) {
      const maxBet = Math.floor(user.balance * 0.5);
      if (amt > maxBet)
        return res.json({ success: false, error: `有未还债务，单次投注不可超过余额的 50%（最多 ¥${maxBet.toLocaleString()}）` });
    }

    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amt, userId);
    db.prepare('INSERT INTO bets (game_id, user_id, team, amount) VALUES (?, ?, ?, ?)').run(gameId, userId, team, amt);

    const allBets = fetchBets(gameId);
    const totals = calcTotals(allBets);
    io.to(`game:${gameId}`).emit('betUpdate', { bets: allBets, totals });

    res.json({ success: true, newBalance: user.balance - amt });
  });

  return router;
};
