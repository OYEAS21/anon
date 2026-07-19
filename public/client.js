const socket = io();

let currentRoomId = null;
let partnerId = null;
let isConnected = false;
let isChatEnded = false;
let typingTimer = null;

const mainScreen = document.getElementById('mainScreen');
const chatScreen = document.getElementById('chatScreen');
const findBtn = document.getElementById('findBtn');
const nextBtn = document.getElementById('nextBtn');
const sendBtn = document.getElementById('sendBtn');
const messageInput = document.getElementById('messageInput');
const messagesDiv = document.getElementById('messages');
const statusMessage = document.getElementById('statusMessage');
const onlineCountSpan = document.getElementById('onlineCount');
const typingIndicator = document.getElementById('typingIndicator');

const genderFilter = document.getElementById('genderFilter');
const ageFilter = document.getElementById('ageFilter');

// ---------- Онлайн-счётчик ----------
socket.on('onlineCount', (count) => {
    onlineCountSpan.textContent = count;
});

// ---------- Мягкий звук (короткий колокольчик) ----------
function playSoftSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const now = audioCtx.currentTime;
        const gain = audioCtx.createGain();
        gain.connect(audioCtx.destination);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

        // Две ноты: 523 Гц (до) и 659 Гц (ми)
        const osc1 = audioCtx.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(523, now);
        osc1.connect(gain);
        osc1.start(now);
        osc1.stop(now + 0.15);

        const osc2 = audioCtx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(659, now + 0.05);
        osc2.connect(gain);
        osc2.start(now + 0.05);
        osc2.stop(now + 0.25);

        // Завершаем контекст
        setTimeout(() => audioCtx.close(), 400);
    } catch (e) {
        console.warn('Звук не воспроизведён', e);
    }
}

// ---------- Звук при завершении чата ----------
function playEndSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const now = audioCtx.currentTime;
        const gain = audioCtx.createGain();
        gain.connect(audioCtx.destination);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(220, now + 0.3);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.3);
        setTimeout(() => audioCtx.close(), 500);
    } catch (e) { /* игнорируем */ }
}

// ---------- Индикатор набора ----------
function showTyping() {
    if (typingIndicator) typingIndicator.textContent = '✏️ Собеседник набирает сообщение...';
}
function hideTyping() {
    if (typingIndicator) typingIndicator.textContent = '';
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
    playSoftSound(); // звук при соединении

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

    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();

    nextBtn.textContent = '➡️ Следующий';
    nextBtn.onclick = handleNext;
});

socket.on('message', (data) => {
    if (isChatEnded) return;
    // Воспроизводим звук при получении сообщения
    playSoftSound();
    appendMessage('other', data.text, data.timestamp);
});

socket.on('partner_left', (data) => {
    if (!isChatEnded) {
        appendMessage('system', data.message || 'Собеседник покинул чат.');
        playEndSound(); // звук завершения
        endChat();
    }
});

socket.on('disconnected', (data) => {
    if (!isChatEnded) {
        appendMessage('system', data.message || 'Вы завершили чат.');
        playEndSound();
        endChat();
    }
});

// ---------- Индикатор набора (от собеседника) ----------
socket.on('typing', () => {
    showTyping();
});

socket.on('stop_typing', () => {
    hideTyping();
});

// ---------- Отправка события при наборе ----------
messageInput.addEventListener('input', () => {
    if (!currentRoomId || isChatEnded) return;
    // Отправляем событие "печатает"
    socket.emit('typing', { roomId: currentRoomId });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        socket.emit('stop_typing', { roomId: currentRoomId });
    }, 1500);
});

messageInput.addEventListener('blur', () => {
    if (currentRoomId) {
        socket.emit('stop_typing', { roomId: currentRoomId });
    }
});

// ---------- Завершение чата ----------
function endChat() {
    isChatEnded = true;
    isConnected = false;
    currentRoomId = null;
    partnerId = null;

    messageInput.disabled = true;
    sendBtn.disabled = true;
    hideTyping();

    nextBtn.textContent = '🔄 Новый чат';
    nextBtn.onclick = startNewChat;
}

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
    hideTyping();
}

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
    // Останавливаем индикатор набора после отправки
    socket.emit('stop_typing', { roomId: currentRoomId });
    clearTimeout(typingTimer);
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