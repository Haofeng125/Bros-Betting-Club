const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');

require('./database');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = 'bros-betting-club-secret-key-2024';

app.use(express.json());
app.use(cookieParser());

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

app.use('/api/auth', authRoutes(JWT_SECRET));
app.use('/api/admin', adminRoutes(JWT_SECRET));

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('未授权'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('未授权'));
  }
});

io.on('connection', (socket) => {
  console.log(`用户连接: ${socket.user.username}`);
  socket.on('disconnect', () => {
    console.log(`用户断开: ${socket.user.username}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`兄弟押注局 运行中 → http://localhost:${PORT}`);
});
