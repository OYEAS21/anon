const socket = io();

let currentRoomId = null;
let partnerId = null;
let isConnected = false;
let isChatEnded = false; // флаг окончания чата (показ истории)

const mainScreen = document.getElementById('mainScreen');
const chatScreen = document.getElementById('chatScreen');
const findBtn = document.getElementById('findBtn');
const nextBtn = document.getElementById('nextBtn');
const sendBtn = document.getElementById('sendBtn');
const messageInput = document.getElementById('messageInput');
const messagesDiv = document.getElementById('messages');
const statusMessage = document.getElementById('statusMessage');

const genderFilter = document.getElementById('genderFilter');
const ageFilter = document.getElementById('ageFilter');

// 🎵 Звук соединения
function playBeep() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        gainNode.gain.value = 0.3;
        oscillator.start();
        setTimeout(() => {
            oscillator.stop();
            audioCtx.close();
        }, 200);
    } catch (e) {
        console.warn('Не удалось воспроизвести звук', e);
    }
}

// ---------- Поиск ----------
findBtn.addEventListener('click', () => {
    const gender = genderFilter.value;
    const age = ageFilter.value;
    statusMessage.textContent = 'Ищем собеседника...';
    findBtn.disabled = true;
    socket.emit('find', { gender, age });
});

// ---------- Сокеты ----------
socket.on('waiting', (data) => {
    statusMessage.textContent = data.message;
    findBtn.disabled = false;
});

socket.on('connected', (data) => {
    playBeep();

    currentRoomId = data.roomId;
    partnerId = data.partner;
    isConnected = true;
    isChatEnded = false;

    statusMessage.textContent = '';
    findBtn.disabled = false;

    // Переключаем экраны
    mainScreen.style.display = 'none';
    chatScreen.style.display = 'block';

    // Очищаем сообщения (на случай, если остались от предыдущего чата)
    messagesDiv.innerHTML = '';
    appendMessage('system', 'Вы соединились с собеседником! Можно писать.');

    // Разблокируем ввод
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();

    // Восстанавливаем кнопку "Следующий"
    nextBtn.textContent = '➡️ Следующий';
    nextBtn.onclick = handleNext; // назначаем обработчик
});

socket.on('message', (data) => {
    // Если чат завершён, сообщения не должны приходить, но на всякий случай проверяем
    if (isChatEnded) return;
    appendMessage('other', data.text, data.timestamp);
});

socket.on('partner_left', (data) => {
    // Собеседник ушёл – показываем историю, блокируем ввод
    if (!isChatEnded) {
        appendMessage('system', data.message || 'Собеседник покинул чат.');
        endChat();
    }
});

socket.on('disconnected', (data) => {
    // Мы сами завершили чат (нажали "Следующий")
    if (!isChatEnded) {
        appendMessage('system', data.message || 'Вы завершили чат.');
        endChat();
    }
});

// ---------- Функция завершения чата (переход в режим просмотра) ----------
function endChat() {
    isChatEnded = true;
    isConnected = false;
    currentRoomId = null;
    partnerId = null;

    // Блокируем ввод
    messageInput.disabled = true;
    sendBtn.disabled = true;

    // Меняем кнопку "Следующий" на "Новый чат"
    nextBtn.textContent = '🔄 Новый чат';
    nextBtn.onclick = startNewChat;
}

// ---------- Начать новый чат (переход на главный экран) ----------
function startNewChat() {
    // Возвращаемся на главный экран
    mainScreen.style.display = 'block';
    chatScreen.style.display = 'none';
    statusMessage.textContent = 'Выберите параметры и начните общение.';
    // Сбрасываем флаги
    isChatEnded = false;
    isConnected = false;
    currentRoomId = null;
    partnerId = null;
    // Восстанавливаем кнопку (на случай, если пользователь вернётся)
    nextBtn.textContent = '➡️ Следующий';
    nextBtn.onclick = handleNext;
    // Очищаем сообщения (чтобы не висели)
    messagesDiv.innerHTML = '';
}

// ---------- Обработчик "Следующий" (активный чат) ----------
function handleNext() {
    if (isChatEnded) {
        // Если по какой-то причине вызвалось, переключаем на новый чат
        startNewChat();
        return;
    }
    if (currentRoomId) {
        socket.emit('next');
        // Сервер пришлёт 'disconnected' -> вызовется endChat()
        // Мы также можем сразу показать статус, но лучше дождаться ответа сервера
        statusMessage.textContent = 'Завершаем чат...';
    }
}

// ---------- Отправка сообщения ----------
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
    if (isChatEnded || !currentRoomId) return;
    const text = messageInput.value.trim();
    if (!text) return;
    appendMessage('self', text);
    socket.emit('message', { roomId: currentRoomId, text });
    messageInput.value = '';
}

// ---------- Вспомогательная функция добавления сообщения ----------
function appendMessage(type, text, timestamp = Date.now()) {
    const div = document.createElement('div');
    div.className = `message ${type}`;
    const time = new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `${text} <span class="time">${time}</span>`;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}