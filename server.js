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
    const columns = await dbAll("PRAGMA table_info(sessions)");
    const colNames = columns.map(c => c.name);
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

// ---------- Socket.IO общие данные ----------
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

// Главная страница админки
app.get('/admin', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = 20;
    const search = req.query.search || '';
    const genderFilter = req.query.gender || 'all';
    const ageFilter = req.query.age || 'all';
    const fromDate = req.query.from || '';
    const toDate = req.query.to || '';

    let sql = `SELECT * FROM sessions WHERE 1=1`;
    const params = [];
    if (search) {
      sql += ` AND (socketId LIKE ? OR ip LIKE ? OR country LIKE ? OR city LIKE ? OR userAgent LIKE ? OR id LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s, s);
    }
    if (genderFilter !== 'all') {
      sql += ` AND gender = ?`;
      params.push(genderFilter);
    }
    if (ageFilter !== 'all') {
      sql += ` AND age = ?`;
      params.push(ageFilter);
    }
    if (fromDate) {
      sql += ` AND startTime >= ?`;
      params.push(new Date(fromDate).getTime());
    }
    if (toDate) {
      sql += ` AND startTime <= ?`;
      params.push(new Date(toDate).getTime());
    }

    const countSql = `SELECT COUNT(*) as total FROM (${sql})`;
    const totalRow = await dbGet(countSql, params);
    const total = totalRow.total;
    const totalPages = Math.ceil(total / perPage);

    const offset = (page - 1) * perPage;
    const dataSql = sql + ` ORDER BY startTime DESC LIMIT ? OFFSET ?`;
    const sessions = await dbAll(dataSql, [...params, perPage, offset]);

    const messages = await dbAll(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT 50`);

    const stats = await getStatsFromDB();

    let html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Админ-панель</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: 'Inter', sans-serif; background:#f7f9fc; padding:20px; margin:0; }
      .container { max-width:1400px; margin:0 auto; }
      h1 { margin-bottom:20px; }
      .stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:14px; margin-bottom:30px; }
      .stat-card { background:white; border-radius:12px; padding:14px 18px; box-shadow:0 4px 12px rgba(0,0,0,0.04); }
      .stat-card .label { font-size:12px; color:#718096; }
      .stat-card .value { font-size:22px; font-weight:700; color:#2d3748; }
      .section { background:white; border-radius:12px; padding:20px; margin-bottom:24px; box-shadow:0 4px 12px rgba(0,0,0,0.04); }
      .section h2 { margin-top:0; font-size:18px; border-bottom:1px solid #eef2f6; padding-bottom:10px; }
      table { width:100%; border-collapse:collapse; font-size:13px; }
      th { text-align:left; padding:8px 6px; background:#f7f9fc; }
      td { padding:8px 6px; border-bottom:1px solid #edf2f7; }
      .filters { display:flex; flex-wrap:wrap; gap:10px; align-items:end; margin-bottom:16px; }
      .filters label { display:flex; flex-direction:column; font-size:12px; gap:3px; }
      .filters input, .filters select { padding:5px 8px; border-radius:6px; border:1px solid #e2e8f0; font-size:13px; }
      .filters button { padding:5px 14px; background:#6b8cae; color:white; border:none; border-radius:6px; cursor:pointer; }
      .pagination { display:flex; gap:6px; margin-top:14px; }
      .pagination a, .pagination span { padding:5px 10px; background:#edf2f7; border-radius:6px; text-decoration:none; color:#2d3748; font-size:13px; }
      .pagination .active { background:#6b8cae; color:white; }
      .delete-btn { background:#e53e3e; color:white; border:none; padding:3px 10px; border-radius:4px; cursor:pointer; font-size:11px; }
      .ban-btn { background:#d69e2e; color:white; border:none; padding:3px 10px; border-radius:4px; cursor:pointer; font-size:11px; }
      @media (max-width:600px) { .stats { grid-template-columns:1fr 1fr; } }
    </style>
    </head>
    <body>
    <div class="container">
      <h1>📊 Админ-панель AnonChistopol</h1>
      <div class="stats">
        <div class="stat-card"><div class="label">👥 Онлайн</div><div class="value">${stats.online}</div></div>
        <div class="stat-card"><div class="label">📋 Сессий</div><div class="value">${stats.totalSessions}</div></div>
        <div class="stat-card"><div class="label">💬 Сообщений</div><div class="value">${stats.totalMessages}</div></div>
        <div class="stat-card"><div class="label">🔄 Чатов</div><div class="value">${stats.activeRooms}</div></div>
        <div class="stat-card"><div class="label">⏳ Очередь</div><div class="value">${stats.waitingUsers}</div></div>
        <div class="stat-card"><div class="label">⏱️ Сред. длит.</div><div class="value">${Math.round(stats.avgDuration)} мин</div></div>
        <div class="stat-card"><div class="label">⚠️ Жалоб</div><div class="value">${stats.totalReports}</div></div>
        <div class="stat-card"><div class="label">🚫 В чёрном списке</div><div class="value">${stats.blacklistCount}</div></div>
      </div>
      <div class="section">
        <h2>📈 Распределение</h2>
        <div style="display:flex; flex-wrap:wrap; gap:15px;">
          <div><strong>Пол:</strong> ${Object.entries(stats.genderStats).map(([k,v]) => `${k}: ${v}`).join(' | ')}</div>
          <div><strong>Возраст:</strong> ${Object.entries(stats.ageStats).map(([k,v]) => `${k}: ${v}`).join(' | ')}</div>
          <div><strong>Устройства:</strong> ${Object.entries(stats.deviceStats).map(([k,v]) => `${k}: ${v}`).join(' | ')}</div>
          <div><strong>Страны:</strong> ${Object.entries(stats.geoStats).map(([k,v]) => `${k}: ${v}`).join(' | ')}</div>
        </div>
      </div>
      <div class="section">
        <h2>🔍 Сессии</h2>
        <form method="GET" action="/admin" class="filters">
          <label>Поиск: <input type="text" name="search" value="${escapeHtml(search)}" placeholder="IP, страна..."></label>
          <label>Пол: <select name="gender"><option value="all">Все</option><option value="male" ${genderFilter==='male'?'selected':''}>М</option><option value="female" ${genderFilter==='female'?'selected':''}>Ж</option><option value="any" ${genderFilter==='any'?'selected':''}>Не важно</option></select></label>
          <label>Возраст: <select name="age"><option value="all">Все</option><option value="17-" ${ageFilter==='17-'?'selected':''}>17-</option><option value="18-25" ${ageFilter==='18-25'?'selected':''}>18-25</option><option value="26-35" ${ageFilter==='26-35'?'selected':''}>26-35</option><option value="36-50" ${ageFilter==='36-50'?'selected':''}>36-50</option><option value="50+" ${ageFilter==='50+'?'selected':''}>50+</option><option value="any" ${ageFilter==='any'?'selected':''}>Не важно</option></select></label>
          <label>С: <input type="date" name="from" value="${escapeHtml(fromDate)}"></label>
          <label>По: <input type="date" name="to" value="${escapeHtml(toDate)}"></label>
          <button type="submit">Применить</button>
          <a href="/admin" style="padding:5px 14px; background:#edf2f7; border-radius:6px; text-decoration:none; color:#2d3748;">Сбросить</a>
        </form>
        <table>
          <tr><th>ID</th><th>IP</th><th>Страна</th><th>Устройство</th><th>ОС</th><th>Пол</th><th>Возраст</th><th>Начало</th><th>Конец</th><th>Сообщ.</th><th>Действие</th></tr>
          ${sessions.map(s => `
            <tr>
              <td>${s.id}</td>
              <td>${escapeHtml(s.ip || '—')}</td>
              <td>${escapeHtml(s.country ? s.country + (s.city ? ', '+s.city : '') : '—')}</td>
              <td>${escapeHtml(s.device || '—')}</td>
              <td>${escapeHtml(s.os || '—')}</td>
              <td>${escapeHtml(s.gender)}</td>
              <td>${escapeHtml(s.age)}</td>
              <td>${new Date(s.startTime).toLocaleString('ru-RU')}</td>
              <td>${s.endTime ? new Date(s.endTime).toLocaleString('ru-RU') : '—'}</td>
              <td>${s.messagesCount || 0}</td>
              <td>
                <form method="POST" action="/admin/delete-session" style="display:inline;" onsubmit="return confirm('Удалить сессию?');">
                  <input type="hidden" name="sessionId" value="${s.id}">
                  <button type="submit" class="delete-btn">Удалить</button>
                </form>
                <a href="/admin/session/${s.id}" style="font-size:11px;">Подробнее</a>
                ${s.ip ? `<form method="POST" action="/admin/blacklist/add" style="display:inline;" onsubmit="return confirm('Заблокировать IP ${escapeHtml(s.ip)}?');"><input type="hidden" name="ip" value="${escapeHtml(s.ip)}"><button type="submit" class="ban-btn">Заблокировать</button></form>` : ''}
              </td>
            </tr>
          `).join('') || '<tr><td colspan="11">Нет сессий</td></tr>'}
        </table>
        <div class="pagination">
          ${Array.from({length: totalPages}, (_, i) => i+1).map(p => `
            <a href="/admin?page=${p}&search=${search}&gender=${genderFilter}&age=${ageFilter}&from=${fromDate}&to=${toDate}" class="${p===page?'active':''}">${p}</a>
          `).join('')}
        </div>
      </div>
      <div class="section">
        <h2>💬 Последние 50 сообщений</h2>
        <table>
          <tr><th>ID</th><th>Сессия</th><th>Текст</th><th>Время</th><th>Действие</th></tr>
          ${messages.map(m => `
            <tr>
              <td>${m.id}</td>
              <td>${m.sessionId}</td>
              <td>${escapeHtml(m.text)}</td>
              <td>${new Date(m.timestamp).toLocaleString('ru-RU')}</td>
              <td>
                <form method="POST" action="/admin/delete-message" style="display:inline;" onsubmit="return confirm('Удалить сообщение?');">
                  <input type="hidden" name="messageId" value="${m.id}">
                  <button type="submit" class="delete-btn">Удалить</button>
                </form>
              </td>
            </tr>
          `).join('') || '<tr><td colspan="5">Нет сообщений</td></tr>'}
        </table>
      </div>
      <div class="section">
        <h2>📥 Экспорт</h2>
        <a href="/admin/export/sessions" style="padding:5px 14px; background:#6b8cae; color:white; border-radius:6px; text-decoration:none; margin-right:8px;">Сессии (CSV)</a>
        <a href="/admin/export/messages" style="padding:5px 14px; background:#6b8cae; color:white; border-radius:6px; text-decoration:none;">Сообщения (CSV)</a>
      </div>
    </div>
    </body>
    </html>
    `;
    res.send(html);
  } catch (err) {
    logger.error('Ошибка в админке:', err);
    res.status(500).send('Ошибка сервера');
  }
});

// ---------- Обработчики админки ----------
app.post('/admin/delete-session', async (req, res) => {
  const sessionId = req.body.sessionId;
  try {
    await dbRun('DELETE FROM sessions WHERE id = ?', [sessionId]);
    await dbRun('DELETE FROM messages WHERE sessionId = ?', [sessionId]);
    res.redirect('/admin');
  } catch (err) {
    logger.error('Ошибка удаления сессии:', err);
    res.status(500).send('Ошибка');
  }
});

app.post('/admin/delete-message', async (req, res) => {
  const messageId = req.body.messageId;
  try {
    await dbRun('DELETE FROM messages WHERE id = ?', [messageId]);
    res.redirect('/admin');
  } catch (err) {
    logger.error('Ошибка удаления сообщения:', err);
    res.status(500).send('Ошибка');
  }
});

app.post('/admin/delete-report', async (req, res) => {
  const reportId = req.body.reportId;
  try {
    await dbRun('DELETE FROM reports WHERE id = ?', [reportId]);
    res.redirect('/admin');
  } catch (err) {
    logger.error('Ошибка удаления жалобы:', err);
    res.status(500).send('Ошибка');
  }
});

app.post('/admin/blacklist/add', async (req, res) => {
  const ip = req.body.ip.trim();
  if (ip) {
    try {
      await dbRun('INSERT OR IGNORE INTO blacklist (ip) VALUES (?)', [ip]);
      broadcastStats();
    } catch (err) {
      logger.error('Ошибка добавления в чёрный список:', err);
    }
  }
  res.redirect('/admin');
});

app.post('/admin/blacklist/remove', async (req, res) => {
  const ip = req.body.ip.trim();
  if (ip) {
    try {
      await dbRun('DELETE FROM blacklist WHERE ip = ?', [ip]);
      broadcastStats();
    } catch (err) {
      logger.error('Ошибка удаления из чёрного списка:', err);
    }
  }
  res.redirect('/admin');
});

app.get('/admin/session/:id', async (req, res) => {
  const sessionId = req.params.id;
  try {
    const session = await dbGet('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return res.send('Сессия не найдена');
    const messages = await dbAll('SELECT * FROM messages WHERE sessionId = ? ORDER BY timestamp', [sessionId]);
    let html = `
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Сессия ${sessionId}</title>
    <style>body{font-family:sans-serif;background:#f7f9fc;padding:20px;} table{width:100%;border-collapse:collapse;} th,td{padding:6px;border-bottom:1px solid #ddd;}</style>
    </head>
    <body>
    <h1>Сессия #${sessionId}</h1>
    <p><strong>Socket:</strong> ${escapeHtml(session.socketId)}</p>
    <p><strong>IP:</strong> ${escapeHtml(session.ip || '—')}</p>
    <p><strong>Страна:</strong> ${escapeHtml(session.country || '—')}, <strong>Город:</strong> ${escapeHtml(session.city || '—')}</p>
    <p><strong>Устройство:</strong> ${escapeHtml(session.device || '—')}, <strong>ОС:</strong> ${escapeHtml(session.os || '—')}</p>
    <p><strong>Браузер:</strong> ${escapeHtml(session.userAgent || '—')}</p>
    <p><strong>Язык:</strong> ${escapeHtml(session.language || '—')}</p>
    <p><strong>Referer:</strong> ${escapeHtml(session.referer || '—')}</p>
    <p><strong>Пол:</strong> ${escapeHtml(session.gender)}, <strong>Возраст:</strong> ${escapeHtml(session.age)}</p>
    <p><strong>Начало:</strong> ${new Date(session.startTime).toLocaleString()}</p>
    <p><strong>Конец:</strong> ${session.endTime ? new Date(session.endTime).toLocaleString() : '—'}</p>
    <p><strong>Сообщений:</strong> ${session.messagesCount || 0}</p>
    <h3>Сообщения</h3>
    <table><tr><th>#</th><th>Текст</th><th>Время</th></tr>
    ${messages.map((m,i) => `<tr><td>${i+1}</td><td>${escapeHtml(m.text)}</td><td>${new Date(m.timestamp).toLocaleString()}</td></tr>`).join('')}
    </table>
    <a href="/admin">← Назад</a>
    </body>
    </html>
    `;
    res.send(html);
  } catch (err) {
    logger.error('Ошибка при просмотре сессии:', err);
    res.status(500).send('Ошибка сервера');
  }
});

app.get('/admin/export/sessions', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM sessions');
    let csv = 'ID, Socket, IP, Страна, Город, Устройство, ОС, Браузер, Язык, Пол, Возраст, Начало, Конец, Сообщений\n';
    rows.forEach(s => {
      csv += `${s.id},${s.socketId},${s.ip||''},${s.country||''},${s.city||''},${s.device||''},${s.os||''},${(s.userAgent||'').replace(/,/g,';')},${s.language||''},${s.gender},${s.age},${new Date(s.startTime).toISOString()},${s.endTime ? new Date(s.endTime).toISOString() : ''},${s.messagesCount||0}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=sessions.csv');
    res.send(csv);
  } catch (err) {
    logger.error('Ошибка экспорта сессий:', err);
    res.status(500).send('Ошибка');
  }
});

app.get('/admin/export/messages', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM messages');
    let csv = 'ID, Сессия, Текст, Время\n';
    rows.forEach(m => {
      csv += `${m.id},${m.sessionId},"${m.text.replace(/"/g, '""')}",${new Date(m.timestamp).toISOString()}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=messages.csv');
    res.send(csv);
  } catch (err) {
    logger.error('Ошибка экспорта сообщений:', err);
    res.status(500).send('Ошибка');
  }
});

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