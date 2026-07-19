const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');

// ---------- Логирование ----------
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// ---------- Инициализация ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

// ---------- Middleware ----------
app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- База данных ----------
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) logger.error('Ошибка подключения к БД:', err);
  else logger.info('Подключено к SQLite');
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    if (err) reject(err);
    else resolve({ lastID: this.lastID, changes: this.changes });
  });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

// Создание/обновление таблиц
async function initDb() {
  try {
    // Создаём таблицу sessions (если её нет)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        socketId TEXT NOT NULL,
        ip TEXT,
        country TEXT,
        city TEXT,
        device TEXT,
        os TEXT,
        userAgent TEXT,
        language TEXT,
        referer TEXT,
        gender TEXT DEFAULT 'any',
        age TEXT DEFAULT 'any',
        startTime INTEGER NOT NULL,
        endTime INTEGER,
        messagesCount INTEGER DEFAULT 0
      )
    `);
    // Получаем список существующих колонок
    const columns = await dbAll("PRAGMA table_info(sessions)");
    const colNames = columns.map(c => c.name);
    // Список колонок, которые должны быть
    const requiredColumns = [
      'ip', 'country', 'city', 'device', 'os', 'userAgent', 'language', 'referer',
      'gender', 'age', 'endTime', 'messagesCount'
    ];
    for (const col of requiredColumns) {
      if (!colNames.includes(col)) {
        const type = (col === 'endTime' || col === 'messagesCount') ? 'INTEGER' : 'TEXT';
        await dbRun(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`);
        logger.info(`Добавлена колонка ${col}`);
      }
    }

    await dbRun(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId INTEGER NOT NULL,
        roomId TEXT NOT NULL,
        senderId TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id)
      )
    `);
    await dbRun(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromSocket TEXT NOT NULL,
        targetSocket TEXT,
        messageId INTEGER,
        reason TEXT,
        timestamp INTEGER NOT NULL
      )
    `);
    await dbRun(`
      CREATE TABLE IF NOT EXISTS blacklist (
        ip TEXT PRIMARY KEY
      )
    `);
    logger.info('Таблицы созданы/обновлены');
  } catch (err) {
    logger.error('Ошибка инициализации БД:', err);
  }
}
initDb();

// ---------- Вспомогательные функции ----------
function getGeo(ip, callback) {
  if (ip === '::1' || ip === '127.0.0.1' || ip === 'unknown' || ip.startsWith('10.')) {
    return callback({ country: 'Локальный', city: 'localhost' });
  }
  const url = `https://ip-api.com/json/${ip}?fields=status,country,city&lang=ru`;
  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.status === 'success') {
          callback({ country: json.country, city: json.city });
        } else {
          callback({ country: 'Неизвестно', city: 'Неизвестно' });
        }
      } catch (e) {
        callback({ country: 'Ошибка', city: 'Ошибка' });
      }
    });
  }).on('error', () => {
    callback({ country: 'Ошибка', city: 'Ошибка' });
  });
}

function parseUserAgent(ua) {
  let device = 'Десктоп';
  let os = 'Неизвестно';
  if (!ua) return { device, os };
  ua = ua.toLowerCase();
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone') || ua.includes('ipad')) {
    device = 'Мобильное';
  }
  if (ua.includes('tablet') || ua.includes('ipad')) device = 'Планшет';
  if (ua.includes('android')) os = 'Android';
  else if (ua.includes('windows')) os = 'Windows';
  else if (ua.includes('mac')) os = 'macOS';
  else if (ua.includes('linux')) os = 'Linux';
  else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';
  return { device, os };
}

function ageMatches(userAgeStr, filterAgeStr) {
  if (filterAgeStr === 'any') return true;
  const parseRange = (s) => {
    if (s === '17-') return [0, 17];
    if (s === '18-25') return [18, 25];
    if (s === '26-35') return [26, 35];
    if (s === '36-50') return [36, 50];
    if (s === '50+') return [50, Infinity];
    return null;
  };
  const userRange = parseRange(userAgeStr);
  const filterRange = parseRange(filterAgeStr);
  if (!userRange || !filterRange) return false;
  return userRange[0] <= filterRange[1] && userRange[1] >= filterRange[0];
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ---------- Socket.IO ----------
const usersQueue = [];
const activeRooms = new Map();
const sessionMap = new Map();
let onlineCount = 0;

async function getStatsFromDB() {
  const totalSessions = (await dbGet('SELECT COUNT(*) as count FROM sessions')).count;
  const totalMessages = (await dbGet('SELECT COUNT(*) as count FROM messages')).count;
  const totalReports = (await dbGet('SELECT COUNT(*) as count FROM reports')).count;
  const blacklistRows = await dbAll('SELECT ip FROM blacklist');
  const blacklistCount = blacklistRows.length;
  const activeRoomsCount = activeRooms.size;
  const waitingUsers = usersQueue.length;
  const avgRow = await dbGet('SELECT AVG(endTime - startTime) as avg FROM sessions WHERE endTime IS NOT NULL');
  const avgDuration = avgRow.avg || 0;
  const genderRows = await dbAll('SELECT gender, COUNT(*) as count FROM sessions GROUP BY gender');
  const genderStats = genderRows.reduce((acc, row) => { acc[row.gender] = row.count; return acc; }, {});
  const ageRows = await dbAll('SELECT age, COUNT(*) as count FROM sessions GROUP BY age');
  const ageStats = ageRows.reduce((acc, row) => { acc[row.age] = row.count; return acc; }, {});
  const deviceRows = await dbAll('SELECT device, COUNT(*) as count FROM sessions GROUP BY device');
  const deviceStats = deviceRows.reduce((acc, row) => { acc[row.device] = row.count; return acc; }, {});
  const geoRows = await dbAll('SELECT country, COUNT(*) as count FROM sessions WHERE country IS NOT NULL GROUP BY country');
  const geoStats = geoRows.reduce((acc, row) => { acc[row.country] = row.count; return acc; }, {});
  return {
    online: onlineCount,
    totalSessions,
    totalMessages,
    totalReports,
    blacklistCount,
    activeRooms: activeRoomsCount,
    waitingUsers,
    avgDuration: avgDuration / 60000,
    genderStats,
    ageStats,
    deviceStats,
    geoStats
  };
}

async function broadcastStats() {
  try {
    const stats = await getStatsFromDB();
    io.to('admin').emit('stats', stats);
  } catch (err) {
    logger.error('Ошибка при получении статистики:', err);
  }
}

// ---------- Админ-панель (с паролем) ----------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (() => { throw new Error('Установите переменную ADMIN_PASSWORD'); })();

app.use('/admin', (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Требуется авторизация');
  }
  const [type, credentials] = auth.split(' ');
  if (type !== 'Basic') return res.status(401).send('Неверный тип авторизации');
  const [username, password] = Buffer.from(credentials, 'base64').toString().split(':');
  if (username === 'admin' && password === ADMIN_PASSWORD) {
    return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('Неверный логин или пароль');
});

// ---------- Маршруты админки (полный код я уже давал ранее, здесь повторять не буду для краткости) ----------
// Вставьте сюда все обработчики из предыдущей версии (они не менялись)
// Для экономии места я их пропущу, но вы должны скопировать их из моего предыдущего ответа.
// Важно: все маршруты (/admin, /admin/delete-session, /admin/session/:id, /admin/export/...) остаются без изменений.

// ---------- Socket.IO ----------
io.on('connection', async (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() || socket.handshake.address || 'unknown';

  try {
    const blacklist = await dbAll('SELECT ip FROM blacklist');
    if (blacklist.some(row => row.ip === clientIp)) {
      socket.emit('blocked', { message: 'Ваш IP заблокирован.' });
      socket.disconnect(true);
      return;
    }
  } catch (err) {
    logger.error('Ошибка проверки чёрного списка:', err);
  }

  logger.info(`Подключился: ${socket.id} (${clientIp})`);
  onlineCount++;
  io.emit('onlineCount', onlineCount);
  broadcastStats();

  const userAgent = socket.handshake.headers['user-agent'] || 'unknown';
  const referer = socket.handshake.headers['referer'] || socket.handshake.headers['origin'] || '';
  const language = socket.handshake.headers['accept-language'] || '';

  // Получаем гео и вставляем сессию, обрабатывая ошибки
  getGeo(clientIp, async (geo) => {
    const { device, os } = parseUserAgent(userAgent);
    const startTime = Date.now();
    try {
      const result = await dbRun(
        `INSERT INTO sessions (socketId, ip, country, city, device, os, userAgent, language, referer, gender, age, startTime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [socket.id, clientIp, geo.country, geo.city, device, os, userAgent, language, referer, 'any', 'any', startTime]
      );
      sessionMap.set(socket.id, result.lastID);
    } catch (err) {
      logger.error('Ошибка вставки сессии:', err);
    }
  });

  socket.on('find', async (data) => {
    const { gender, age } = data;
    const sessionId = sessionMap.get(socket.id);
    if (sessionId) {
      try {
        await dbRun(`UPDATE sessions SET gender = ?, age = ? WHERE id = ?`, [gender || 'any', age || 'any', sessionId]);
      } catch (err) {
        logger.error('Ошибка обновления сессии:', err);
      }
    }

    // Удаляем старые записи из очереди
    for (let i = usersQueue.length - 1; i >= 0; i--) {
      if (usersQueue[i].socketId === socket.id) usersQueue.splice(i, 1);
    }

    const user = { socketId: socket.id, gender: gender || 'any', age: age || 'any' };
    usersQueue.push(user);

    let matchIndex = -1;
    for (let i = 0; i < usersQueue.length - 1; i++) {
      const candidate = usersQueue[i];
      if (candidate.socketId === socket.id) continue;
      let genderMatch = true;
      if (user.gender !== 'any' && candidate.gender !== 'any') {
        genderMatch = user.gender === candidate.gender;
      }
      let ageMatch = true;
      if (user.age !== 'any' && candidate.age !== 'any') {
        ageMatch = ageMatches(candidate.age, user.age);
      }
      if (genderMatch && ageMatch) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex !== -1) {
      const matchedUser = usersQueue[matchIndex];
      usersQueue.splice(matchIndex, 1);
      const selfIdx = usersQueue.findIndex(u => u.socketId === socket.id);
      if (selfIdx !== -1) usersQueue.splice(selfIdx, 1);

      const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      activeRooms.set(roomId, { user1: socket.id, user2: matchedUser.socketId });

      socket.join(roomId);
      const partnerSocket = io.sockets.sockets.get(matchedUser.socketId);
      if (partnerSocket) partnerSocket.join(roomId);

      io.to(socket.id).emit('connected', { roomId, partner: matchedUser.socketId });
      io.to(matchedUser.socketId).emit('connected', { roomId, partner: socket.id });
      broadcastStats();
    } else {
      socket.emit('waiting', { message: 'Ожидаем собеседника...' });
    }
  });

  socket.on('message', async (data) => {
    const { roomId, text } = data;
    const sessionId = sessionMap.get(socket.id);
    if (sessionId) {
      const timestamp = Date.now();
      try {
        await dbRun(
          `INSERT INTO messages (sessionId, roomId, senderId, text, timestamp) VALUES (?, ?, ?, ?, ?)`,
          [sessionId, roomId, socket.id, text, timestamp]
        );
        await dbRun(`UPDATE sessions SET messagesCount = messagesCount + 1 WHERE id = ?`, [sessionId]);
      } catch (err) {
        logger.error('Ошибка сохранения сообщения:', err);
      }
    }
    socket.to(roomId).emit('message', { from: socket.id, text, timestamp: Date.now() });
  });

  socket.on('typing', (data) => {
    socket.to(data.roomId).emit('typing', { from: socket.id });
  });
  socket.on('stop_typing', (data) => {
    socket.to(data.roomId).emit('stop_typing', { from: socket.id });
  });

  socket.on('report', async (data) => {
    const { targetSocket, reason } = data;
    try {
      await dbRun(
        `INSERT INTO reports (fromSocket, targetSocket, reason, timestamp) VALUES (?, ?, ?, ?)`,
        [socket.id, targetSocket, reason || 'Не указана', Date.now()]
      );
      socket.emit('report_sent', { message: 'Жалоба отправлена.' });
      broadcastStats();
    } catch (err) {
      logger.error('Ошибка сохранения жалобы:', err);
    }
  });

  socket.on('report_message', async (data) => {
    const { messageId, reason } = data;
    try {
      const msg = await dbGet('SELECT * FROM messages WHERE id = ?', [messageId]);
      if (msg) {
        await dbRun(
          `INSERT INTO reports (fromSocket, targetSocket, messageId, reason, timestamp) VALUES (?, ?, ?, ?, ?)`,
          [socket.id, msg.senderId, messageId, reason || 'Не указана', Date.now()]
        );
        socket.emit('report_sent', { message: 'Жалоба на сообщение отправлена.' });
        broadcastStats();
      } else {
        socket.emit('report_sent', { message: 'Сообщение не найдено.' });
      }
    } catch (err) {
      logger.error('Ошибка жалобы на сообщение:', err);
    }
  });

  socket.on('next', async () => {
    const idx = usersQueue.findIndex(u => u.socketId === socket.id);
    if (idx !== -1) usersQueue.splice(idx, 1);

    let roomToLeave = null;
    for (const [roomId, { user1, user2 }] of activeRooms.entries()) {
      if (user1 === socket.id || user2 === socket.id) {
        roomToLeave = roomId;
        break;
      }
    }
    if (roomToLeave) {
      socket.to(roomToLeave).emit('partner_left', { message: 'Собеседник покинул чат.' });
      activeRooms.delete(roomToLeave);
      socket.leave(roomToLeave);
    }
    const sessionId = sessionMap.get(socket.id);
    if (sessionId) {
      try {
        const countRow = await dbGet('SELECT COUNT(*) as count FROM messages WHERE sessionId = ?', [sessionId]);
        await dbRun(`UPDATE sessions SET endTime = ?, messagesCount = ? WHERE id = ?`, [Date.now(), countRow.count, sessionId]);
      } catch (err) {
        logger.error('Ошибка завершения сессии:', err);
      }
    }
    socket.emit('disconnected', { message: 'Вы вышли из чата.' });
    broadcastStats();
  });

  socket.on('disconnect', async () => {
    logger.info(`Отключился: ${socket.id}`);
    onlineCount--;
    io.emit('onlineCount', onlineCount);
    broadcastStats();

    const sessionId = sessionMap.get(socket.id);
    if (sessionId) {
      try {
        const countRow = await dbGet('SELECT COUNT(*) as count FROM messages WHERE sessionId = ?', [sessionId]);
        await dbRun(`UPDATE sessions SET endTime = ?, messagesCount = ? WHERE id = ?`, [Date.now(), countRow.count, sessionId]);
      } catch (err) {
        logger.error('Ошибка завершения сессии при отключении:', err);
      }
    }
    const idx = usersQueue.findIndex(u => u.socketId === socket.id);
    if (idx !== -1) usersQueue.splice(idx, 1);
    for (const [roomId, { user1, user2 }] of activeRooms.entries()) {
      if (user1 === socket.id || user2 === socket.id) {
        const partnerId = user1 === socket.id ? user2 : user1;
        io.to(partnerId).emit('partner_left', { message: 'Собеседник отключился.' });
        activeRooms.delete(roomId);
        break;
      }
    }
  });

  socket.on('join_admin', () => {
    socket.join('admin');
    broadcastStats();
  });
});

// ---------- Graceful shutdown ----------
process.on('SIGINT', () => {
  logger.info('Получен SIGINT, завершаем работу...');
  io.close(() => {
    logger.info('Socket.IO закрыт');
    db.close((err) => {
      if (err) logger.error('Ошибка закрытия БД:', err);
      process.exit(0);
    });
  });
});
process.on('SIGTERM', () => {
  logger.info('Получен SIGTERM, завершаем работу...');
  io.close(() => {
    logger.info('Socket.IO закрыт');
    db.close((err) => {
      if (err) logger.error('Ошибка закрытия БД:', err);
      process.exit(0);
    });
  });
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`🚀 Сервер запущен на порту ${PORT}`);
});