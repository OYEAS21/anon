const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // для локальной разработки, при продакшене ограничьте своим доменом
    methods: ['GET', 'POST']
  }
});

// Раздача статики
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());

// Хранилище пользователей в очереди (в памяти)
const usersQueue = []; // { socketId, gender, age, interests? }

// Хранилище активных пар { roomId: { user1, user2 } }
const activeRooms = new Map();

io.on('connection', (socket) => {
  console.log(`Пользователь подключился: ${socket.id}`);

  // Обработчик поиска собеседника
  socket.on('find', (data) => {
    const { gender, age } = data; // данные фильтра
    // Сохраняем пользователя в очередь
    const user = {
      socketId: socket.id,
      gender: gender || 'any',
      age: age || 'any'
    };
    usersQueue.push(user);

    // Ищем подходящего собеседника (с учетом фильтров, но упрощённо - ищем первого подходящего)
    let matchIndex = -1;
    for (let i = 0; i < usersQueue.length - 1; i++) {
      const candidate = usersQueue[i];
      if (candidate.socketId === socket.id) continue; // себя не берём
      // Простая проверка: если указан пол, то ищем совпадение
      let genderMatch = true;
      if (user.gender !== 'any' && candidate.gender !== 'any') {
        genderMatch = user.gender === candidate.gender;
      }
      // Возраст пока игнорируем для упрощения
      if (genderMatch) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex !== -1) {
      // Нашли пару
      const matchedUser = usersQueue[matchIndex];
      // Удаляем обоих из очереди
      usersQueue.splice(matchIndex, 1);
      const selfIndex = usersQueue.findIndex(u => u.socketId === socket.id);
      if (selfIndex !== -1) usersQueue.splice(selfIndex, 1);

      // Создаём комнату
      const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      activeRooms.set(roomId, {
        user1: socket.id,
        user2: matchedUser.socketId
      });

      // Присоединяем обоих к комнате
      socket.join(roomId);
      io.sockets.sockets.get(matchedUser.socketId)?.join(roomId);

      // Уведомляем обоих о соединении
      io.to(socket.id).emit('connected', { roomId, partner: matchedUser.socketId });
      io.to(matchedUser.socketId).emit('connected', { roomId, partner: socket.id });
    } else {
      // Не нашли пару, ждём
      socket.emit('waiting', { message: 'Ожидаем собеседника...' });
    }
  });

  // Обработчик отправки сообщения
  socket.on('message', (data) => {
    const { roomId, text } = data;
    // Отправляем сообщение всем в комнате, кроме отправителя
    socket.to(roomId).emit('message', { from: socket.id, text, timestamp: Date.now() });
  });

  // Обработчик разрыва (следующий собеседник)
  socket.on('next', () => {
    // Найти комнату, в которой находится пользователь
    let roomToLeave = null;
    for (const [roomId, { user1, user2 }] of activeRooms.entries()) {
      if (user1 === socket.id || user2 === socket.id) {
        roomToLeave = roomId;
        break;
      }
    }
    if (roomToLeave) {
      // Уведомить собеседника, что партнёр ушёл
      socket.to(roomToLeave).emit('partner_left', { message: 'Собеседник покинул чат.' });
      // Удалить комнату
      activeRooms.delete(roomToLeave);
      // Выйти из комнаты
      socket.leave(roomToLeave);
    }
    // Удалить пользователя из очереди (если он там)
    const idx = usersQueue.findIndex(u => u.socketId === socket.id);
    if (idx !== -1) usersQueue.splice(idx, 1);
    // Отправить клиенту, что можно искать снова
    socket.emit('disconnected', { message: 'Вы вышли из чата. Можете начать поиск заново.' });
  });

  // При отключении
  socket.on('disconnect', () => {
    console.log(`Пользователь отключился: ${socket.id}`);
    // Удалить из очереди
    const idx = usersQueue.findIndex(u => u.socketId === socket.id);
    if (idx !== -1) usersQueue.splice(idx, 1);
    // Найти и закрыть комнату, если была
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
  console.log(`Сервер запущен на порту ${PORT}`);
});