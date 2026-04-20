const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();
const db = require('./database');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'bros-betting-club-secret-key-2024';

app.use(express.json());
app.use(cookieParser());

// ── Auth middleware ──

function requireAuth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login.html');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.redirect('/login.html');
  }
}

function requireAdmin(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login.html');
  try {
    const user = jwt.verify(token, JWT_SECRET);
    if (!user.isAdmin) return res.status(403).send('无权限');
    req.user = user;
    next();
  } catch {
    res.redirect('/login.html');
  }
}

// ── API routes ──

app.use('/api/auth', authRoutes(JWT_SECRET));
app.use('/api/admin', adminRoutes(JWT_SECRET, io));
app.use('/api/loan', require('./routes/loan')(JWT_SECRET));

// ── Page routes ──

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/game/:id', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/history/:id', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/me', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'me.html'));
});

app.get('/intro', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'intro.html'));
});

app.get('/leaderboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/loan', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'loan.html'));
});

app.get('/my-history', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'my-history.html'));
});

app.get('/change-password', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'change-password.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Socket.io: auth via httpOnly cookie ──

io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  if (!match) return next(new Error('未授权'));
  try {
    socket.user = jwt.verify(match[1], JWT_SECRET);
    next();
  } catch {
    next(new Error('未授权'));
  }
});

io.on('connection', (socket) => {
  socket.on('joinGame', (gameId) => {
    socket.join(`game:${gameId}`);
  });
  socket.on('disconnect', () => {});
});

// Register game routes after io is ready
const gameRoutes = require('./routes/game');
app.use('/api/game', gameRoutes(JWT_SECRET, io));

// ── Auto-close games past deadline ──

function closeExpiredGames() {
  const now = new Date().toISOString();
  const expired = db.prepare(`
    SELECT id FROM games WHERE status IN ('open', 'pending') AND deadline <= ?
  `).all(now);

  expired.forEach(({ id }) => {
    db.prepare(`UPDATE games SET status = 'closed' WHERE id = ?`).run(id);
    io.to(`game:${id}`).emit('gameStatusChanged', { status: 'closed' });
    console.log(`比赛 #${id} 投注已截止`);
  });
}

setInterval(closeExpiredGames, 15000);

// ── Start ──

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`兄弟押注局 运行中 → http://localhost:${PORT}`);
});
