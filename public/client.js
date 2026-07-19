const socket = io();

let currentRoomId = null;
let partnerId = null;
let isConnected = false;
let isChatEnded = false;

const mainScreen = document.getElementById('mainScreen');
const chatScreen = document.getElementById('chatScreen');
const findBtn = document.getElementById('findBtn');
const nextBtn = document.getElementById('nextBtn');
const sendBtn = document.getElementById('sendBtn');
const messageInput = document.getElementById('messageInput');
const messagesDiv = document.getElementById('messages');
const statusMessage = document.getElementById('statusMessage');
const onlineCountSpan = document.getElementById('onlineCount');

const genderFilter = document.getElementById('genderFilter');
const ageFilter = document.getElementById('ageFilter');

// ---------- Онлайн-счётчик ----------
socket.on('onlineCount', (count) => {
    onlineCountSpan.textContent = count;
});

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

    mainScreen.style.display = 'none';
    chatScreen.style.display = 'block';

    messagesDiv.innerHTML = '';
    appendMessage('system', 'Вы соединились с собеседником! Можно писать.');

    // Разблокируем ввод
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();

    nextBtn.textContent = '➡️ Следующий';
    nextBtn.onclick = handleNext;
});

socket.on('message', (data) => {
    if (isChatEnded) return;
    appendMessage('other', data.text, data.timestamp);
});

socket.on('partner_left', (data) => {
    if (!isChatEnded) {
        appendMessage('system', data.message || 'Собеседник покинул чат.');
        endChat();
    }
});

socket.on('disconnected', (data) => {
    if (!isChatEnded) {
        appendMessage('system', data.message || 'Вы завершили чат.');
        endChat();
    }
});

// ---------- Функция завершения чата (режим просмотра) ----------
function endChat() {
    isChatEnded = true;
    isConnected = false;
    currentRoomId = null;
    partnerId = null;

    messageInput.disabled = true;
    sendBtn.disabled = true;

    nextBtn.textContent = '🔄 Новый чат';
    nextBtn.onclick = startNewChat;
}

// ---------- Начать новый чат ----------
function startNewChat() {
    mainScreen.style.display = 'block';
    chatScreen.style.display = 'none';
    statusMessage.textContent = 'Выберите параметры и начните общение.';
    isChatEnded = false;
    isConnected = false;
    currentRoomId = null;
    partnerId = null;
    nextBtn.textContent = '➡️ Следующий';
    nextBtn.onclick = handleNext;
    messagesDiv.innerHTML = '';
}

// ---------- Обработчик "Следующий" ----------
function handleNext() {
    if (isChatEnded) {
        startNewChat();
        return;
    }
    if (currentRoomId) {
        socket.emit('next');
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

// ---------- Вспомогательная функция ----------
function appendMessage(type, text, timestamp = Date.now()) {
    const div = document.createElement('div');
    div.className = `message ${type}`;
    const time = new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `${text} <span class="time">${time}</span>`;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}