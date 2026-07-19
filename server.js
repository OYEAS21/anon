const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ---------- База данных ----------
const db = new sqlite3.Database('./chat.db');

db.serialize(() => {
  // Таблица сессий
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      socketId TEXT,
      gender TEXT,
      age TEXT,
      startTime INTEGER,
      endTime INTEGER,
      messagesCount INTEGER DEFAULT 0
    )
  `);
  // Таблица сообщений
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId INTEGER,
      roomId TEXT,
      senderId TEXT,
      text TEXT,
      timestamp INTEGER,
      FOREIGN KEY (sessionId) REFERENCES sessions(id)
    )
  `);
});

// ---------- Middleware ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());

// ---------- Админ-панель (только для владельца) ----------
const ADMIN_PASSWORD = 'NKHG8DFHJs1'; // 🛠 Смените пароль!

app.get('/admin', (req, res) => {
  // Простая HTML-страница для просмотра логов
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Админ-панель AnonChistopol</title></head>
    <body style="font-family:sans-serif;background:#f7f9fc;padding:20px;">
      <h2>📊 Логи сессий и сообщений</h2>
      <form method="POST" action="/admin">
        <label>Введите пароль: <input type="password" name="password" /></label>
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

  // Получаем последние 20 сессий и сообщений
  db.all(`
    SELECT s.*, 
           (SELECT COUNT(*) FROM messages WHERE sessionId = s.id) as msgCount
    FROM sessions s
    ORDER BY s.startTime DESC
    LIMIT 20
  `, (err, sessions) => {
    if (err) return res.send('Ошибка БД');

    db.all(`
      SELECT m.*, s.gender, s.age 
      FROM messages m
      JOIN sessions s ON m.sessionId = s.id
      ORDER BY m.timestamp DESC
      LIMIT 50
    `, (err2, messages) => {
      if (err2) return res.send('Ошибка БД');

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
      sessions.forEach(s => {
        const start = new Date(s.startTime).toLocaleString('ru-RU');
        const end = s.endTime ? new Date(s.endTime).toLocaleString('ru-RU') : '—';
        html += `<tr><td>${s.id}</td><td>${s.socketId}</td><td>${s.gender}</td><td>${s.age}</td><td>${start}</td><td>${end}</td><td>${s.msgCount || 0}</td></tr>`;
      });
      html += `</table></div>`;

      html += `<div class="section"><h2>Последние 50 сообщений</h2><table><tr><th>ID</th><th>Сессия</th><th>Пол</th><th>Возраст</th><th>Текст</th><th>Время</th></tr>`;
      messages.forEach(m => {
        const time = new Date(m.timestamp).toLocaleString('ru-RU');
        html += `<tr><td>${m.id}</td><td>${m.sessionId}</td><td>${m.gender}</td><td>${m.age}</td><td>${m.text}</td><td>${time}</td></tr>`;
      });
      html += `</table></div></body></html>`;
      res.send(html);
    });
  });
});

// ---------- Хранилище активных комнат и очереди ----------
const usersQueue = [];
const activeRooms = new Map();

// Хранилище сессий (socketId -> sessionId)
const sessionMap = new Map();

io.on('connection', (socket) => {
  console.log(`🔌 Подключился: ${socket.id}`);

  // Создаём сессию в БД
  db.run(
    `INSERT INTO sessions (socketId, startTime) VALUES (?, ?)`,
    [socket.id, Date.now()],
    function(err) {
      if (!err) {
        sessionMap.set(socket.id, this.lastID);
      }
    }
  );

  socket.on('find', (data) => {
    const { gender, age } = data;

    // Обновляем сессию: сохраняем выбранные фильтры
    const sessionId = sessionMap.get(socket.id);
    if (sessionId) {
      db.run(
        `UPDATE sessions SET gender = ?, age = ? WHERE id = ?`,
        [gender || 'any', age || 'any', sessionId]
      );
    }

    const user = { socketId: socket.id, gender: gender || 'any', age: age || 'any' };
    usersQueue.push(user);

    // Ищем пару (упрощённо: если пол совпадает, берём первого подходящего)
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

      // Обновим сессии: запомним roomId? Не обязательно.
    } else {
      socket.emit('waiting', { message: 'Ожидаем собеседника...' });
    }
  });

  socket.on('message', (data) => {
    const { roomId, text } = data;
    const sessionId = sessionMap.get(socket.id);
    if (sessionId) {
      db.run(
        `INSERT INTO messages (sessionId, roomId, senderId, text, timestamp) VALUES (?, ?, ?, ?, ?)`,
        [sessionId, roomId, socket.id, text, Date.now()]
      );
      // Увеличиваем счётчик сообщений в сессии
      db.run(
        `UPDATE sessions SET messagesCount = messagesCount + 1 WHERE id = ?`,
        [sessionId]
      );
    }
    socket.to(roomId).emit('message', { from: socket.id, text, timestamp: Date.now() });
  });

  socket.on('next', () => {
    // Закрываем комнату
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
    // Закрываем сессию (время окончания)
    const sessionId = sessionMap.get(socket.id);
    if (sessionId) {
      db.run(`UPDATE sessions SET endTime = ? WHERE id = ?`, [Date.now(), sessionId]);
    }
    socket.emit('disconnected', { message: 'Вы вышли из чата.' });
  });

  socket.on('disconnect', () => {
    console.log(`❌ Отключился: ${socket.id}`);
    // Закрываем сессию
    const sessionId = sessionMap.get(socket.id);
    if (sessionId) {
      db.run(`UPDATE sessions SET endTime = ? WHERE id = ?`, [Date.now(), sessionId]);
    }
    // Удаляем из очереди
    const idx = usersQueue.findIndex(u => u.socketId === socket.id);
    if (idx !== -1) usersQueue.splice(idx, 1);
    // Закрываем активную комнату, если была
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