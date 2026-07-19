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

let nextSessionId = sessions.length > 0 ? Math.max(...sessions.map(s => s.id)) + 1 : 1;
let nextMsgId = messages.length > 0 ? Math.max(...messages.map(m => m.id)) + 1 : 1;

// ---------- Middleware ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Вспомогательная функция для получения IP ----------
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

// ---------- Socket.IO ----------
const usersQueue = [];
const activeRooms = new Map();
const sessionMap = new Map();
let onlineCount = 0;

// Статистика для админки
const getStats = () => ({
  online: onlineCount,
  totalSessions: sessions.length,
  totalMessages: messages.length,
  activeRooms: activeRooms.size,
  waitingUsers: usersQueue.length,
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
  }, {})
});

// ---------- Админ-панель (расширенная) ----------
app.get('/admin', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = 20;
  const search = req.query.search || '';
  const genderFilter = req.query.gender || 'all';
  const ageFilter = req.query.age || 'all';
  const fromDate = req.query.from || '';
  const toDate = req.query.to || '';

  let filteredSessions = [...sessions];
  if (search) {
    const s = search.toLowerCase();
    filteredSessions = filteredSessions.filter(sess =>
      sess.socketId.toLowerCase().includes(s) ||
      sess.id.toString().includes(s) ||
      (sess.gender && sess.gender.includes(s)) ||
      (sess.age && sess.age.includes(s)) ||
      (sess.ip && sess.ip.includes(s)) ||
      (sess.userAgent && sess.userAgent.toLowerCase().includes(s))
    );
  }
  if (genderFilter !== 'all') {
    filteredSessions = filteredSessions.filter(sess => sess.gender === genderFilter);
  }
  if (ageFilter !== 'all') {
    filteredSessions = filteredSessions.filter(sess => sess.age === ageFilter);
  }
  if (fromDate) {
    const from = new Date(fromDate).getTime();
    filteredSessions = filteredSessions.filter(sess => sess.startTime >= from);
  }
  if (toDate) {
    const to = new Date(toDate).getTime();
    filteredSessions = filteredSessions.filter(sess => sess.startTime <= to);
  }

  filteredSessions.sort((a, b) => b.startTime - a.startTime);
  const totalFiltered = filteredSessions.length;
  const totalPages = Math.ceil(totalFiltered / perPage);
  const offset = (page - 1) * perPage;
  const pagedSessions = filteredSessions.slice(offset, offset + perPage);

  const stats = getStats();

  // Функция для обрезки User-Agent
  const shortUA = (ua) => {
    if (!ua) return '—';
    if (ua.includes('Chrome')) return 'Chrome';
    if (ua.includes('Firefox')) return 'Firefox';
    if (ua.includes('Safari')) return 'Safari';
    if (ua.includes('Edge')) return 'Edge';
    if (ua.includes('Opera')) return 'Opera';
    if (ua.includes('Mobile')) return 'Mobile';
    return ua.slice(0, 20) + '...';
  };

  let html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Админ-панель AnonChistopol</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: 'Inter', sans-serif; background:#f7f9fc; padding:20px; margin:0; }
      .container { max-width:1400px; margin:0 auto; }
      h1 { margin-bottom:20px; }
      .stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px,1fr)); gap:16px; margin-bottom:30px; }
      .stat-card { background:white; border-radius:12px; padding:16px 20px; box-shadow:0 4px 12px rgba(0,0,0,0.04); }
      .stat-card .label { font-size:13px; color:#718096; }
      .stat-card .value { font-size:24px; font-weight:700; color:#2d3748; }
      .stat-card .sub { font-size:14px; color:#4a5568; margin-top:4px; }
      .section { background:white; border-radius:12px; padding:20px; margin-bottom:24px; box-shadow:0 4px 12px rgba(0,0,0,0.04); }
      .section h2 { margin-top:0; font-size:18px; border-bottom:1px solid #eef2f6; padding-bottom:10px; }
      table { width:100%; border-collapse:collapse; font-size:14px; }
      th { text-align:left; padding:10px 8px; background:#f7f9fc; }
      td { padding:10px 8px; border-bottom:1px solid #edf2f7; }
      .filters { display:flex; flex-wrap:wrap; gap:12px; align-items:end; margin-bottom:16px; }
      .filters label { display:flex; flex-direction:column; font-size:13px; gap:4px; }
      .filters input, .filters select { padding:6px 10px; border-radius:6px; border:1px solid #e2e8f0; font-size:14px; }
      .filters button { padding:6px 16px; background:#6b8cae; color:white; border:none; border-radius:6px; cursor:pointer; }
      .filters button:hover { background:#5a7a9a; }
      .pagination { display:flex; gap:8px; margin-top:16px; }
      .pagination a, .pagination span { padding:6px 12px; background:#edf2f7; border-radius:6px; text-decoration:none; color:#2d3748; }
      .pagination .active { background:#6b8cae; color:white; }
      .delete-btn { background:#e53e3e; color:white; border:none; padding:4px 12px; border-radius:4px; cursor:pointer; font-size:12px; }
      .delete-btn:hover { background:#c53030; }
      .rooms-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px,1fr)); gap:12px; }
      .room-card { background:#f7f9fc; border-radius:8px; padding:12px; }
      .room-card code { background:#edf2f7; padding:2px 6px; border-radius:4px; font-size:12px; }
      .queue-list { display:flex; flex-wrap:wrap; gap:8px; }
      .queue-item { background:#edf2f7; padding:6px 12px; border-radius:20px; font-size:13px; }
      .search-results { margin-top:16px; }
      .msg-text { max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      @media (max-width:600px) { .stats { grid-template-columns:1fr 1fr; } }
    </style>
  </head>
  <body>
  <div class="container">
    <h1>📊 Админ-панель AnonChistopol</h1>

    <!-- Статистика -->
    <div class="stats">
      <div class="stat-card"><div class="label">👥 Онлайн</div><div class="value">${stats.online}</div></div>
      <div class="stat-card"><div class="label">📋 Всего сессий</div><div class="value">${stats.totalSessions}</div></div>
      <div class="stat-card"><div class="label">💬 Всего сообщений</div><div class="value">${stats.totalMessages}</div></div>
      <div class="stat-card"><div class="label">🔄 Активных чатов</div><div class="value">${stats.activeRooms}</div></div>
      <div class="stat-card"><div class="label">⏳ В очереди</div><div class="value">${stats.waitingUsers}</div></div>
      <div class="stat-card"><div class="label">⏱️ Средняя длительность</div><div class="value">${Math.round(stats.avgDuration)} мин</div></div>
    </div>

    <!-- Распределение -->
    <div class="section">
      <h2>📈 Распределение</h2>
      <div style="display:flex; flex-wrap:wrap; gap:20px;">
        <div><strong>Пол:</strong> ${Object.entries(stats.genderStats).map(([k,v]) => `${k}: ${v}`).join(' | ')}</div>
        <div><strong>Возраст:</strong> ${Object.entries(stats.ageStats).map(([k,v]) => `${k}: ${v}`).join(' | ')}</div>
      </div>
    </div>

    <!-- Активные комнаты -->
    <div class="section">
      <h2>🔄 Активные комнаты (${activeRooms.size})</h2>
      <div class="rooms-grid">
        ${Array.from(activeRooms.entries()).map(([roomId, {user1, user2}]) => `
          <div class="room-card">
            <code>${roomId}</code><br>
            👤 ${user1} ↔️ ${user2}
          </div>
        `).join('') || '<div>Нет активных комнат</div>'}
      </div>
    </div>

    <!-- Очередь -->
    <div class="section">
      <h2>⏳ Очередь ожидающих (${usersQueue.length})</h2>
      <div class="queue-list">
        ${usersQueue.map(u => `<span class="queue-item">${u.socketId} (${u.gender}, ${u.age})</span>`).join('') || 'Очередь пуста'}
      </div>
    </div>

    <!-- Фильтры и список сессий -->
    <div class="section">
      <h2>🔍 Сессии (с IP и браузером)</h2>
      <form method="GET" action="/admin" class="filters">
        <label>Поиск: <input type="text" name="search" value="${search}" placeholder="ID, socketId, IP, браузер..."></label>
        <label>Пол: <select name="gender"><option value="all">Все</option><option value="male" ${genderFilter==='male'?'selected':''}>Мужской</option><option value="female" ${genderFilter==='female'?'selected':''}>Женский</option><option value="any" ${genderFilter==='any'?'selected':''}>Не важно</option></select></label>
        <label>Возраст: <select name="age"><option value="all">Все</option><option value="17-" ${ageFilter==='17-'?'selected':''}>17-</option><option value="18-25" ${ageFilter==='18-25'?'selected':''}>18-25</option><option value="26-35" ${ageFilter==='26-35'?'selected':''}>26-35</option><option value="36-50" ${ageFilter==='36-50'?'selected':''}>36-50</option><option value="50+" ${ageFilter==='50+'?'selected':''}>50+</option><option value="any" ${ageFilter==='any'?'selected':''}>Не важно</option></select></label>
        <label>С: <input type="date" name="from" value="${fromDate}"></label>
        <label>По: <input type="date" name="to" value="${toDate}"></label>
        <button type="submit">Применить</button>
        <a href="/admin" style="padding:6px 16px; background:#edf2f7; border-radius:6px; text-decoration:none; color:#2d3748;">Сбросить</a>
      </form>

      <table>
        <tr><th>ID</th><th>Socket</th><th>IP</th><th>Браузер</th><th>Пол</th><th>Возраст</th><th>Начало</th><th>Конец</th><th>Сообщений</th><th>Действие</th></tr>
        ${pagedSessions.map(s => `
          <tr>
            <td>${s.id}</td>
            <td><code>${s.socketId}</code></td>
            <td>${s.ip || '—'}</td>
            <td>${s.userAgent ? shortUA(s.userAgent) : '—'}</td>
            <td>${s.gender}</td>
            <td>${s.age}</td>
            <td>${new Date(s.startTime).toLocaleString('ru-RU')}</td>
            <td>${s.endTime ? new Date(s.endTime).toLocaleString('ru-RU') : '—'}</td>
            <td>${s.messagesCount || 0}</td>
            <td>
              <form method="POST" action="/admin/delete-session" style="display:inline;" onsubmit="return confirm('Удалить сессию и все сообщения?');">
                <input type="hidden" name="sessionId" value="${s.id}">
                <button type="submit" class="delete-btn">Удалить</button>
              </form>
              <a href="/admin/session/${s.id}" style="font-size:12px;">Подробнее</a>
            </td>
          </tr>
        `).join('') || '<tr><td colspan="10">Нет сессий</td></tr>'}
      </table>
      <div class="pagination">
        ${Array.from({length: totalPages}, (_, i) => i+1).map(p => `
          <a href="/admin?page=${p}&search=${search}&gender=${genderFilter}&age=${ageFilter}&from=${fromDate}&to=${toDate}" class="${p===page?'active':''}">${p}</a>
        `).join('')}
      </div>
    </div>

    <!-- Последние сообщения -->
    <div class="section">
      <h2>💬 Последние 50 сообщений</h2>
      <table>
        <tr><th>ID</th><th>Сессия</th><th>Отправитель</th><th>Текст</th><th>Время</th><th>Действие</th></tr>
        ${[...messages].sort((a,b)=>b.timestamp - a.timestamp).slice(0,50).map(m => {
          const session = sessions.find(s => s.id === m.sessionId);
          return `
          <tr>
            <td>${m.id}</td>
            <td>${m.sessionId}</td>
            <td><code>${m.senderId}</code></td>
            <td class="msg-text" title="${m.text}">${m.text}</td>
            <td>${new Date(m.timestamp).toLocaleString('ru-RU')}</td>
            <td>
              <form method="POST" action="/admin/delete-message" style="display:inline;" onsubmit="return confirm('Удалить сообщение?');">
                <input type="hidden" name="messageId" value="${m.id}">
                <button type="submit" class="delete-btn">Удалить</button>
              </form>
            </td>
          </tr>
          `;
        }).join('') || '<tr><td colspan="6">Нет сообщений</td></tr>'}
      </table>
    </div>

    <!-- Экспорт -->
    <div class="section">
      <h2>📥 Экспорт данных</h2>
      <a href="/admin/export/sessions" style="padding:6px 16px; background:#6b8cae; color:white; border-radius:6px; text-decoration:none; margin-right:10px;">Экспорт сессий (CSV)</a>
      <a href="/admin/export/messages" style="padding:6px 16px; background:#6b8cae; color:white; border-radius:6px; text-decoration:none;">Экспорт сообщений (CSV)</a>
    </div>

  </div>
  </body>
  </html>
  `;
  res.send(html);
});

// ---------- Просмотр одной сессии (детали с IP) ----------
app.get('/admin/session/:id', (req, res) => {
  const sessionId = parseInt(req.params.id);
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return res.send('Сессия не найдена');
  const sessionMessages = messages.filter(m => m.sessionId === sessionId).sort((a,b) => a.timestamp - b.timestamp);
  let html = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"><title>Сессия ${sessionId}</title>
  <style>body{font-family:sans-serif;background:#f7f9fc;padding:20px;} table{width:100%;border-collapse:collapse;} th,td{padding:8px;border-bottom:1px solid #ddd;}</style>
  </head>
  <body>
  <h1>Сессия #${sessionId}</h1>
  <p><strong>Socket:</strong> ${session.socketId}</p>
  <p><strong>IP:</strong> ${session.ip || '—'}</p>
  <p><strong>User-Agent:</strong> ${session.userAgent || '—'}</p>
  <p><strong>Referer:</strong> ${session.referer || '—'}</p>
  <p><strong>Пол:</strong> ${session.gender}, <strong>Возраст:</strong> ${session.age}</p>
  <p><strong>Начало:</strong> ${new Date(session.startTime).toLocaleString()}</p>
  <p><strong>Конец:</strong> ${session.endTime ? new Date(session.endTime).toLocaleString() : '—'}</p>
  <p><strong>Сообщений:</strong> ${session.messagesCount || 0}</p>
  <h3>Сообщения</h3>
  <table><tr><th>#</th><th>Отправитель</th><th>Текст</th><th>Время</th></tr>
  ${sessionMessages.map((m,i) => `<tr><td>${i+1}</td><td>${m.senderId}</td><td>${m.text}</td><td>${new Date(m.timestamp).toLocaleString()}</td></tr>`).join('')}
  </table>
  <a href="/admin">← Назад</a>
  </body>
  </html>
  `;
  res.send(html);
});

// ---------- Удаление сессии ----------
app.post('/admin/delete-session', (req, res) => {
  const sessionId = parseInt(req.body.sessionId);
  sessions = sessions.filter(s => s.id !== sessionId);
  saveData(SESSIONS_FILE, sessions);
  messages = messages.filter(m => m.sessionId !== sessionId);
  saveData(MESSAGES_FILE, messages);
  res.redirect('/admin');
});

// ---------- Удаление сообщения ----------
app.post('/admin/delete-message', (req, res) => {
  const messageId = parseInt(req.body.messageId);
  messages = messages.filter(m => m.id !== messageId);
  saveData(MESSAGES_FILE, messages);
  const msg = messages.find(m => m.id === messageId);
  if (msg) {
    const session = sessions.find(s => s.id === msg.sessionId);
    if (session) {
      session.messagesCount = messages.filter(m => m.sessionId === session.id).length;
      saveData(SESSIONS_FILE, sessions);
    }
  }
  res.redirect('/admin');
});

// ---------- Экспорт CSV (добавим IP и User-Agent) ----------
app.get('/admin/export/sessions', (req, res) => {
  let csv = 'ID, Socket, IP, UserAgent, Referer, Пол, Возраст, Начало, Конец, Сообщений\n';
  sessions.forEach(s => {
    csv += `${s.id},${s.socketId},${s.ip || ''},${(s.userAgent || '').replace(/,/g,';')},${(s.referer || '').replace(/,/g,';')},${s.gender},${s.age},${new Date(s.startTime).toISOString()},${s.endTime ? new Date(s.endTime).toISOString() : ''},${s.messagesCount || 0}\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=sessions.csv');
  res.send(csv);
});

app.get('/admin/export/messages', (req, res) => {
  let csv = 'ID, Сессия, Отправитель, Текст, Время\n';
  messages.forEach(m => {
    csv += `${m.id},${m.sessionId},${m.senderId},"${m.text.replace(/"/g, '""')}",${new Date(m.timestamp).toISOString()}\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=messages.csv');
  res.send(csv);
});

// ---------- Socket.IO логика (с сохранением IP и User-Agent) ----------
io.on('connection', (socket) => {
  console.log(`🔌 Подключился: ${socket.id}`);
  onlineCount++;
  io.emit('onlineCount', onlineCount);
  console.log(`👥 Онлайн: ${onlineCount}`);

  // Получаем IP и User-Agent из handshake
  const clientIp = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() || socket.handshake.address || 'unknown';
  const userAgent = socket.handshake.headers['user-agent'] || 'unknown';
  const referer = socket.handshake.headers['referer'] || socket.handshake.headers['origin'] || '';

  // Создаём сессию с дополнительными полями
  const session = {
    id: nextSessionId++,
    socketId: socket.id,
    ip: clientIp,
    userAgent: userAgent,
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

  socket.on('next', () => {
    // Удаляем из очереди (если пользователь там оказался)
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

  socket.on('disconnect', () => {
    console.log(`❌ Отключился: ${socket.id}`);
    onlineCount--;
    io.emit('onlineCount', onlineCount);
    console.log(`👥 Онлайн: ${onlineCount}`);

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