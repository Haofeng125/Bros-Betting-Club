const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');

module.exports = (JWT_SECRET, io) => {
  const router = express.Router();

  function requireAdmin(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: '未授权' });
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (!user.isAdmin) return res.status(403).json({ error: '无权限' });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: '未授权' });
    }
  }

  // ── 玩家管理 ──

  router.get('/users', requireAdmin, (req, res) => {
    const users = db.prepare(`
      SELECT id, username, balance, loan_amount, is_admin
      FROM users ORDER BY balance DESC
    `).all();
    res.json(users);
  });

  router.post('/users', requireAdmin, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
      return res.json({ success: false, error: '请填写完整信息' });

    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) return res.json({ success: false, error: '用户名已存在' });

    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
    res.json({ success: true });
  });

  router.put('/users/:id', requireAdmin, (req, res) => {
    const { balance, password } = req.body;
    const id = parseInt(req.params.id);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.json({ success: false, error: '用户不存在' });

    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
    }
    if (balance !== undefined && !isNaN(balance))
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(parseInt(balance), id);

    res.json({ success: true });
  });

  router.delete('/users/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.json({ success: false, error: '用户不存在' });
    if (user.is_admin) return res.json({ success: false, error: '不能删除管理员账户' });
    db.prepare('DELETE FROM bets WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ success: true });
  });

  // ── 比赛管理 ──

  router.get('/games', requireAdmin, (req, res) => {
    const games = db.prepare('SELECT * FROM games ORDER BY created_at DESC LIMIT 30').all();
    res.json(games);
  });

  router.post('/games', requireAdmin, (req, res) => {
    const { team_a, team_b, deadline, odds_a, odds_b } = req.body;
    if (!team_a || !team_b || !deadline || !odds_a || !odds_b)
      return res.json({ success: false, error: '请填写完整比赛信息（包含赔率）' });

    const oa = parseFloat(odds_a);
    const ob = parseFloat(odds_b);
    if (isNaN(oa) || oa <= 1.0 || isNaN(ob) || ob <= 1.0)
      return res.json({ success: false, error: '赔率必须大于 1.0' });

    db.prepare(`
      INSERT INTO games (team_a, team_b, deadline, odds_a, odds_b, status)
      VALUES (?, ?, ?, ?, ?, 'open')
    `).run(team_a, team_b, deadline, oa, ob);

    res.json({ success: true });
  });

  router.delete('/games/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!game) return res.json({ success: false, error: '比赛不存在' });
    if (game.status === 'settled') return res.json({ success: false, error: '已结算的比赛不能删除' });
    db.prepare('DELETE FROM bets WHERE game_id = ?').run(id);
    db.prepare('DELETE FROM games WHERE id = ?').run(id);
    res.json({ success: true });
  });

  // ── 结算 ──

  router.post('/games/:id/settle', requireAdmin, (req, res) => {
    const gameId = parseInt(req.params.id);
    const { winner } = req.body; // 'A' or 'B'

    if (!['A', 'B'].includes(winner))
      return res.json({ success: false, error: '请选择胜利队伍' });

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) return res.json({ success: false, error: '比赛不存在' });
    if (game.status === 'settled') return res.json({ success: false, error: '比赛已结算' });

    const settle = db.transaction(() => {
      const bets = db.prepare(`
        SELECT b.id, b.user_id, b.team, b.amount, u.username
        FROM bets b JOIN users u ON b.user_id = u.id
        WHERE b.game_id = ? AND b.status = 'active'
      `).all(gameId);

      const results = [];

      // Edge case: nobody bet → void
      if (!bets.length) {
        db.prepare(`UPDATE games SET status = 'voided' WHERE id = ?`).run(gameId);
        io.to(`game:${gameId}`).emit('gameStatusChanged', { status: 'voided' });
        return { voided: true, results };
      }

      const winningOdds = winner === 'A' ? game.odds_a : game.odds_b;
      const winnerName = winner === 'A' ? game.team_a : game.team_b;

      for (const bet of bets) {
        const won = bet.team === winner;
        if (won) {
          const payout = Math.floor(bet.amount * winningOdds);
          const profit = payout - bet.amount;
          db.prepare('UPDATE users SET balance = balance + ?, weekly_profit = weekly_profit + ? WHERE id = ?').run(payout, profit, bet.user_id);
          results.push({ username: bet.username, type: '获胜', amount: payout, profit });
        } else {
          db.prepare('UPDATE users SET weekly_profit = weekly_profit - ? WHERE id = ?').run(bet.amount, bet.user_id);
          results.push({ username: bet.username, type: '落败', profit: -bet.amount });
        }
      }

      db.prepare(`UPDATE games SET status = 'settled', winner = ? WHERE id = ?`).run(winner, gameId);
      io.to(`game:${gameId}`).emit('gameStatusChanged', { status: 'settled', winner, winnerName });

      return { voided: false, winner, winnerName, results, oddsA: game.odds_a, oddsB: game.odds_b };
    });

    try {
      const outcome = settle();
      res.json({ success: true, ...outcome });
    } catch (err) {
      res.json({ success: false, error: '结算失败：' + err.message });
    }
  });

  // ── 修改结算结果 ──

  router.post('/games/:id/resettle', requireAdmin, (req, res) => {
    const gameId = parseInt(req.params.id);
    const { winner } = req.body;

    if (!['A', 'B'].includes(winner))
      return res.json({ success: false, error: '请选择胜利队伍' });

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) return res.json({ success: false, error: '比赛不存在' });
    if (game.status !== 'settled') return res.json({ success: false, error: '只能修改已结算的比赛' });
    if (game.winner === winner) return res.json({ success: false, error: '与当前结果相同，无需修改' });

    const resettle = db.transaction(() => {
      const bets = db.prepare(`
        SELECT b.id, b.user_id, b.team, b.amount, u.username
        FROM bets b JOIN users u ON b.user_id = u.id
        WHERE b.game_id = ? AND b.status = 'active'
      `).all(gameId);

      const oldWinner = game.winner;
      const oldOdds = oldWinner === 'A' ? game.odds_a : game.odds_b;
      const newOdds = winner === 'A' ? game.odds_a : game.odds_b;
      const newWinnerName = winner === 'A' ? game.team_a : game.team_b;
      const results = [];

      for (const bet of bets) {
        const wasWinner = bet.team === oldWinner;
        const isWinner  = bet.team === winner;

        if (wasWinner && !isWinner) {
          // Was winner, now loser: reverse old payout, record new loss
          const oldPayout = Math.floor(bet.amount * oldOdds);
          db.prepare(`
            UPDATE users SET
              balance = balance - ?,
              weekly_profit = weekly_profit - ? - ?
            WHERE id = ?
          `).run(oldPayout, oldPayout - bet.amount, bet.amount, bet.user_id);
          results.push({ username: bet.username, type: '落败', profit: -bet.amount });

        } else if (!wasWinner && isWinner) {
          // Was loser, now winner: reverse old loss, give new payout
          const newPayout = Math.floor(bet.amount * newOdds);
          db.prepare(`
            UPDATE users SET
              balance = balance + ?,
              weekly_profit = weekly_profit + ? + ?
            WHERE id = ?
          `).run(newPayout, bet.amount, newPayout - bet.amount, bet.user_id);
          results.push({ username: bet.username, type: '获胜', amount: newPayout, profit: newPayout - bet.amount });
        }
      }

      db.prepare(`UPDATE games SET winner = ? WHERE id = ?`).run(winner, gameId);
      io.to(`game:${gameId}`).emit('gameStatusChanged', { status: 'settled', winner, winnerName: newWinnerName });

      return { winner, winnerName: newWinnerName, results, oddsA: game.odds_a, oddsB: game.odds_b };
    });

    try {
      const outcome = resettle();
      res.json({ success: true, ...outcome });
    } catch (err) {
      res.json({ success: false, error: '修改失败：' + err.message });
    }
  });

  return router;
};
