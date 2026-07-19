const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ---------- Хранилище в JSON-файлах ----------
const SESSIONS_FILE = './sessions.json';
const MESSAGES_FILE = './messages.json';

// Загружаем данные из файлов (или создаём пустые)
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

// Вспомогательная функция для сохранения сессии
function saveSession(session) {
  // Ищем существующую
  const index = sessions.findIndex(s => s.id === session.id);
  if (index !== -1) {
    sessions[index] = session;
  } else {
    sessions.push(session);
  }
  saveData(SESSIONS_FILE, sessions);
}

// ---------- Middleware ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());

// ---------- Админ-панель ----------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.get('/admin', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Админ-панель</title></head>
    <body style="font-family:sans-serif;background:#f7f9fc;padding:20px;">
      <h2>📊 Логи сессий и сообщений</h2>
      <form method="POST" action="/admin">
        <label>Пароль: <input type="password" name="password" /></label>
        <button type="submit">Войти</button>
      </form>
    </body>
    </html>
  `);
});

app.post('/admin', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.send('❌ Неверный пароль. <a href="/admin">Попробовать снова</a>');
  }

  // Сортируем по времени (новые сверху)
  const sortedSessions = [...sessions].sort((a,b) => b.startTime - a.startTime).slice(0, 20);
  const sortedMessages = [...messages].sort((a,b) => b.timestamp - a.timestamp).slice(0, 50);

  let html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Логи</title>
    <style>
      body { font-family: 'Inter', sans-serif; background:#f7f9fc; padding:20px; }
      table { border-collapse: collapse; width:100%; background:white; border-radius:12px; overflow:hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
      th, td { padding:10px 14px; text-align:left; border-bottom:1px solid #eef2f6; }
      th { background:#edf2f7; }
      .section { margin-bottom:40px; }
    </style>
    </head>
    <body>
      <h1>📊 Админ-панель</h1>
      <div class="section">
        <h2>Последние сессии (20)</h2>
        <table>
          <tr><th>ID</th><th>Socket</th><th>Пол</th><th>Возраст</th><th>Начало</th><th>Конец</th><th>Сообщений</th></tr>
  `;
  sortedSessions.forEach(s => {
    const start = new Date(s.startTime).toLocaleString('ru-RU');
    const end = s.endTime ? new Date(s.endTime).toLocaleString('ru-RU') : '—';
    html += `<tr><td>${s.id}</td><td>${s.socketId}</td><td>${s.gender}</td><td>${s.age}</td><td>${start}</td><td>${end}</td><td>${s.messagesCount || 0}</td></tr>`;
  });
  html += `</table></div>`;

  html += `<div class="section"><h2>Последние 50 сообщений</h2><table><tr><th>ID</th><th>Сессия</th><th>Пол</th><th>Возраст</th><th>Текст</th><th>Время</th></tr>`;
  sortedMessages.forEach(m => {
    const time = new Date(m.timestamp).toLocaleString('ru-RU');
    const session = sessions.find(s => s.id === m.sessionId);
    html += `<tr><td>${m.id}</td><td>${m.sessionId}</td><td>${session ? session.gender : '?'}</td><td>${session ? session.age : '?'}</td><td>${m.text}</td><td>${time}</td></tr>`;
  });
  html += `</table></div></body></html>`;
  res.send(html);
});

// ---------- Socket.IO логика ----------
let nextSessionId = sessions.length > 0 ? Math.max(...sessions.map(s => s.id)) + 1 : 1;
let nextMsgId = messages.length > 0 ? Math.max(...messages.map(m => m.id)) + 1 : 1;

const usersQueue = [];
const activeRooms = new Map();
const sessionMap = new Map(); // socketId -> sessionId

io.on('connection', (socket) => {
  console.log(`🔌 Подключился: ${socket.id}`);

  // Создаём сессию
  const session = {
    id: nextSessionId++,
    socketId: socket.id,
    gender: 'any',
    age: 'any',
    startTime: Date.now(),
    endTime: null,
    messagesCount: 0
  };
  sessions.push(session);
  saveData(SESSIONS_FILE, sessions);
  sessionMap.set(socket.id, session.id);

  socket.on('find', (data) => {
    const { gender, age } = data;
    // Обновляем сессию
    const sess = sessions.find(s => s.id === sessionMap.get(socket.id));
    if (sess) {
      sess.gender = gender || 'any';
      sess.age = age || 'any';
      saveData(SESSIONS_FILE, sessions);
    }

    const user = { socketId: socket.id, gender: sess.gender, age: sess.age };
    usersQueue.push(user);

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
      activeRooms.set(roomId, {
        user1: socket.id,
        user2: matchedUser.socketId
      });

      socket.join(roomId);
      io.sockets.sockets.get(matchedUser.socketId)?.join(roomId);

      io.to(socket.id).emit('connected', { roomId, partner: matchedUser.socketId });
      io.to(matchedUser.socketId).emit('connected', { roomId, partner: socket.id });
    } else {
      socket.emit('waiting', { message: 'Ожидаем собеседника...' });
    }
  });

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

      // Увеличиваем счётчик сообщений в сессии
      const sess = sessions.find(s => s.id === sessionId);
      if (sess) {
        sess.messagesCount = (sess.messagesCount || 0) + 1;
        saveData(SESSIONS_FILE, sessions);
      }
    }
    socket.to(roomId).emit('message', { from: socket.id, text, timestamp: Date.now() });
  });

  socket.on('next', () => {
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
    // Закрываем сессию
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

  socket.on('disconnect', () => {
    console.log(`❌ Отключился: ${socket.id}`);
    const sessionId = sessionMap.get(socket.id);
    if (sessionId) {
      const sess = sessions.find(s => s.id === sessionId);
      if (sess) {
        sess.endTime = Date.now();
        saveData(SESSIONS_FILE, sessions);
      }
    }
    // Удаляем из очереди
    const idx = usersQueue.findIndex(u => u.socketId === socket.id);
    if (idx !== -1) usersQueue.splice(idx, 1);
    // Закрываем комнату
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