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
    const { balance, password, loan_amount } = req.body;
    const id = parseInt(req.params.id);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.json({ success: false, error: '用户不存在' });

    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
    }
    if (balance !== undefined && !isNaN(balance))
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(parseInt(balance), id);
    if (loan_amount !== undefined && !isNaN(loan_amount))
      db.prepare('UPDATE users SET loan_amount = ? WHERE id = ?').run(Math.max(0, parseInt(loan_amount)), id);

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

  // ── Settlement calculation helper ──

  // Calculates actual payout (win) or recovery (loss) for a bet,
  // applying brokie rewards and debt tax.
  // user.balance must be the balance AFTER the bet was deducted (as stored in DB at settlement time).
  function calcBetOutcome(user, betAmount, won, winningOdds) {
    // Total assets = current balance + all pending bets - loan_amount
    const pendingRow = db.prepare(`
      SELECT COALESCE(SUM(b.amount), 0) AS total
      FROM bets b JOIN games g ON b.game_id = g.id
      WHERE b.user_id = ? AND b.status = 'active' AND g.status NOT IN ('settled', 'voided')
    `).get(user.id);
    const totalAssets = user.balance + pendingRow.total - user.loan_amount;

    if (won) {
      const basePayout = Math.floor(betAmount * winningOdds);
      const baseProfit = basePayout - betAmount;

      // Brokie bonus
      let adjustedProfit;
      if (totalAssets < 0) {
        // Tier 1: 15% more on full payout (bet + profit)
        adjustedProfit = Math.floor(basePayout * 1.15) - betAmount;
      } else if (totalAssets <= 5000) {
        // Tier 2: 15% more on net profit only
        adjustedProfit = Math.floor(baseProfit * 1.15);
      } else {
        adjustedProfit = baseProfit;
      }

      // Debt tax: only on profit, compare balance vs loan_amount
      if (user.loan_amount > 0) {
        let keepRate = 1.0;
        if (user.balance >= 3 * user.loan_amount)      keepRate = 0.50;
        else if (user.balance >= 2 * user.loan_amount) keepRate = 0.70;
        else if (user.balance >= user.loan_amount)     keepRate = 0.90;

        if (keepRate < 1.0) {
          adjustedProfit = Math.floor(adjustedProfit * keepRate);
        }
      }

      const finalPayout = betAmount + adjustedProfit;
      return {
        payout: finalPayout,
        recovery: 0,
        balanceDelta: finalPayout,
        weeklyProfitDelta: adjustedProfit,
        totalAssets,
      };
    } else {
      // Loss recovery (no debt tax applied)
      let recovery = 0;
      if (totalAssets < 0) {
        recovery = Math.floor(betAmount * 0.30);
      } else if (totalAssets <= 5000) {
        recovery = Math.floor(betAmount * 0.10);
      }

      return {
        payout: 0,
        recovery,
        balanceDelta: recovery,
        weeklyProfitDelta: -(betAmount - recovery),
        totalAssets,
      };
    }
  }

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
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(bet.user_id);
        const outcome = calcBetOutcome(user, bet.amount, won, winningOdds);

        db.prepare('UPDATE users SET balance = balance + ?, weekly_profit = weekly_profit + ? WHERE id = ?')
          .run(outcome.balanceDelta, outcome.weeklyProfitDelta, bet.user_id);
        db.prepare('UPDATE bets SET payout = ?, recovery = ? WHERE id = ?')
          .run(outcome.payout, outcome.recovery, bet.id);

        if (won) {
          results.push({ username: bet.username, type: '获胜', amount: outcome.payout, profit: outcome.weeklyProfitDelta });
        } else {
          results.push({ username: bet.username, type: '落败', profit: outcome.weeklyProfitDelta, recovery: outcome.recovery });
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
        SELECT b.id, b.user_id, b.team, b.amount, b.payout, b.recovery, u.username
        FROM bets b JOIN users u ON b.user_id = u.id
        WHERE b.game_id = ? AND b.status = 'active'
      `).all(gameId);

      const oldWinner = game.winner;
      const newOdds = winner === 'A' ? game.odds_a : game.odds_b;
      const newWinnerName = winner === 'A' ? game.team_a : game.team_b;
      const results = [];

      for (const bet of bets) {
        const wasWinner = bet.team === oldWinner;
        const isWinner  = bet.team === winner;

        if (wasWinner && !isWinner) {
          // Was winner → now loser: reverse old payout, apply new loss
          db.prepare('UPDATE users SET balance = balance - ?, weekly_profit = weekly_profit - ? WHERE id = ?')
            .run(bet.payout, bet.payout - bet.amount, bet.user_id);

          const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(bet.user_id);
          const outcome = calcBetOutcome(updatedUser, bet.amount, false, newOdds);

          db.prepare('UPDATE users SET balance = balance + ?, weekly_profit = weekly_profit + ? WHERE id = ?')
            .run(outcome.balanceDelta, outcome.weeklyProfitDelta, bet.user_id);
          db.prepare('UPDATE bets SET payout = 0, recovery = ? WHERE id = ?')
            .run(outcome.recovery, bet.id);

          results.push({ username: bet.username, type: '落败', profit: outcome.weeklyProfitDelta, recovery: outcome.recovery });

        } else if (!wasWinner && isWinner) {
          // Was loser → now winner: reverse old recovery, apply new win
          db.prepare('UPDATE users SET balance = balance - ?, weekly_profit = weekly_profit + ? WHERE id = ?')
            .run(bet.recovery, bet.amount - bet.recovery, bet.user_id);

          const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(bet.user_id);
          const outcome = calcBetOutcome(updatedUser, bet.amount, true, newOdds);

          db.prepare('UPDATE users SET balance = balance + ?, weekly_profit = weekly_profit + ? WHERE id = ?')
            .run(outcome.balanceDelta, outcome.weeklyProfitDelta, bet.user_id);
          db.prepare('UPDATE bets SET payout = ?, recovery = 0 WHERE id = ?')
            .run(outcome.payout, bet.id);

          results.push({ username: bet.username, type: '获胜', amount: outcome.payout, profit: outcome.weeklyProfitDelta });
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
