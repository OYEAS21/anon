const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ---------- Хранилище ----------
const SESSIONS_FILE = './sessions.json';
const MESSAGES_FILE = './messages.json';
const REPORTS_FILE = './reports.json';
const BLACKLIST_FILE = './blacklist.json';

function loadData(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) { console.error('Ошибка загрузки', file, e); }
  return [];
}
function saveData(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

let sessions = loadData(SESSIONS_FILE);
let messages = loadData(MESSAGES_FILE);
let reports = loadData(REPORTS_FILE);
let blacklist = loadData(BLACKLIST_FILE);

let nextSessionId = sessions.length > 0 ? Math.max(...sessions.map(s => s.id)) + 1 : 1;
let nextMsgId = messages.length > 0 ? Math.max(...messages.map(m => m.id)) + 1 : 1;
let nextReportId = reports.length > 0 ? Math.max(...reports.map(r => r.id)) + 1 : 1;

// ---------- Middleware ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Функция гео (исправлен протокол) ----------
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

// ---------- Определение устройства и ОС (исправлено) ----------
function parseUserAgent(ua) {
  let device = 'Десктоп';
  let os = 'Неизвестно';
  if (!ua) return { device, os };
  ua = ua.toLowerCase();
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone') || ua.includes('ipad')) {
    device = 'Мобильное';
  }
  if (ua.includes('tablet') || ua.includes('ipad')) device = 'Планшет';
  // Определяем ОС (сначала android, потом linux)
  if (ua.includes('android')) os = 'Android';
  else if (ua.includes('windows')) os = 'Windows';
  else if (ua.includes('mac')) os = 'macOS';
  else if (ua.includes('linux')) os = 'Linux';
  else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';
  return { device, os };
}

// ---------- Socket.IO ----------
const usersQueue = [];
const activeRooms = new Map();
const sessionMap = new Map();
let onlineCount = 0;

const getStats = () => ({
  online: onlineCount,
  totalSessions: sessions.length,
  totalMessages: messages.length,
  activeRooms: activeRooms.size,
  waitingUsers: usersQueue.length,
  totalReports: reports.length,
  blacklistCount: blacklist.length,
  avgDuration: sessions.reduce((acc, s) => {
    if (s.startTime && s.endTime) return acc + (s.endTime - s.startTime);
    return acc;
  }, 0) / (sessions.filter(s => s.endTime).length || 1) / 60000,
  genderStats: sessions.reduce((acc, s) => {
    const g = s.gender || 'any';
    acc[g] = (acc[g] || 0) + 1;
    return acc;
  }, {}),
  ageStats: sessions.reduce((acc, s) => {
    const a = s.age || 'any';
    acc[a] = (acc[a] || 0) + 1;
    return acc;
  }, {}),
  deviceStats: sessions.reduce((acc, s) => {
    const d = s.device || 'Неизвестно';
    acc[d] = (acc[d] || 0) + 1;
    return acc;
  }, {}),
  geoStats: sessions.reduce((acc, s) => {
    if (s.country) {
      acc[s.country] = (acc[s.country] || 0) + 1;
    }
    return acc;
  }, {})
});

// ---------- Админ-панель (полная, без изменений) ----------
// ... (вставьте сюда весь код админки из предыдущего ответа, он остаётся рабочим)
// Я не буду повторять его для экономии места, но убедитесь, что он там есть.

// ---------- Обработчики админки (без изменений) ----------
// ... (все обработчики из предыдущего ответа)

// ---------- Socket.IO (исправленная логика поиска) ----------
io.on('connection', (socket) => {
  // Проверка чёрного списка
  const clientIp = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() || socket.handshake.address || 'unknown';
  if (blacklist.includes(clientIp)) {
    socket.emit('blocked', { message: 'Ваш IP заблокирован администратором.' });
    socket.disconnect(true);
    return;
  }

  console.log(`🔌 Подключился: ${socket.id} (${clientIp})`);
  onlineCount++;
  io.emit('onlineCount', onlineCount);

  // Собираем данные о пользователе
  const userAgent = socket.handshake.headers['user-agent'] || 'unknown';
  const referer = socket.handshake.headers['referer'] || socket.handshake.headers['origin'] || '';
  const language = socket.handshake.headers['accept-language'] || '';

  // Получаем гео асинхронно
  getGeo(clientIp, (geo) => {
    const { device, os } = parseUserAgent(userAgent);
    const session = {
      id: nextSessionId++,
      socketId: socket.id,
      ip: clientIp,
      country: geo.country,
      city: geo.city,
      device: device,
      os: os,
      userAgent: userAgent,
      language: language,
      referer: referer,
      gender: 'any',
      age: 'any',
      startTime: Date.now(),
      endTime: null,
      messagesCount: 0
    };
    sessions.push(session);
    saveData(SESSIONS_FILE, sessions);
    sessionMap.set(socket.id, session.id);
  });

  // ---------- Поиск собеседника (исправлен) ----------
  socket.on('find', (data) => {
    const { gender, age } = data;
    const sess = sessions.find(s => s.id === sessionMap.get(socket.id));
    if (sess) {
      sess.gender = gender || 'any';
      sess.age = age || 'any';
      saveData(SESSIONS_FILE, sessions);
    }

    // Удаляем старые записи этого сокета из очереди (предотвращаем дублирование)
    const existingIndex = usersQueue.findIndex(u => u.socketId === socket.id);
    if (existingIndex !== -1) usersQueue.splice(existingIndex, 1);

    const user = { socketId: socket.id, gender: sess.gender, age: sess.age };
    usersQueue.push(user);

    // Ищем подходящего собеседника (упрощённо: совпадение по полу, если указан)
    let matchIndex = -1;
    for (let i = 0; i < usersQueue.length - 1; i++) {
      const candidate = usersQueue[i];
      if (candidate.socketId === socket.id) continue;
      let genderMatch = true;
      if (user.gender !== 'any' && candidate.gender !== 'any') {
        genderMatch = user.gender === candidate.gender;
      }
      if (genderMatch) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex !== -1) {
      const matchedUser = usersQueue[matchIndex];
      usersQueue.splice(matchIndex, 1);
      const selfIndex = usersQueue.findIndex(u => u.socketId === socket.id);
      if (selfIndex !== -1) usersQueue.splice(selfIndex, 1);

      const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      activeRooms.set(roomId, { user1: socket.id, user2: matchedUser.socketId });

      socket.join(roomId);
      io.sockets.sockets.get(matchedUser.socketId)?.join(roomId);

      io.to(socket.id).emit('connected', { roomId, partner: matchedUser.socketId });
      io.to(matchedUser.socketId).emit('connected', { roomId, partner: socket.id });
    } else {
      socket.emit('waiting', { message: 'Ожидаем собеседника...' });
    }
  });

  // ---------- Сообщение ----------
  socket.on('message', (data) => {
    const { roomId, text } = data;
    const sessionId = sessionMap.get(socket.id);
    if (sessionId) {
      const msg = {
        id: nextMsgId++,
        sessionId: sessionId,
        roomId: roomId,
        senderId: socket.id,
        text: text,
        timestamp: Date.now()
      };
      messages.push(msg);
      saveData(MESSAGES_FILE, messages);

      const sess = sessions.find(s => s.id === sessionId);
      if (sess) {
        sess.messagesCount = (sess.messagesCount || 0) + 1;
        saveData(SESSIONS_FILE, sessions);
      }
    }
    socket.to(roomId).emit('message', { from: socket.id, text, timestamp: Date.now() });
  });

  // ---------- Следующий собеседник ----------
  socket.on('next', () => {
    // Удаляем из очереди (если там есть)
    const queueIdx = usersQueue.findIndex(u => u.socketId === socket.id);
    if (queueIdx !== -1) usersQueue.splice(queueIdx, 1);

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
      const sess = sessions.find(s => s.id === sessionId);
      if (sess) {
        sess.endTime = Date.now();
        saveData(SESSIONS_FILE, sessions);
      }
    }
    socket.emit('disconnected', { message: 'Вы вышли из чата.' });
  });

  // ---------- Жалоба ----------
  socket.on('report', (data) => {
    const report = {
      id: nextReportId++,
      fromSocket: socket.id,
      targetSocket: data.targetSocket,
      reason: data.reason || 'Не указана',
      timestamp: Date.now()
    };
    reports.push(report);
    saveData(REPORTS_FILE, reports);
    socket.emit('report_sent', { message: 'Жалоба отправлена.' });
  });

  // ---------- Отключение ----------
  socket.on('disconnect', () => {
    console.log(`❌ Отключился: ${socket.id}`);
    onlineCount--;
    io.emit('onlineCount', onlineCount);

    const sessionId = sessionMap.get(socket.id);
    if (sessionId) {
      const sess = sessions.find(s => s.id === sessionId);
      if (sess) {
        sess.endTime = Date.now();
        saveData(SESSIONS_FILE, sessions);
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});