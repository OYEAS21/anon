const socket = io();

let currentRoomId = null;
let partnerId = null;
let isConnected = false;

const mainScreen = document.getElementById('mainScreen');
const chatScreen = document.getElementById('chatScreen');
const findBtn = document.getElementById('findBtn');
const nextBtn = document.getElementById('nextBtn');
const sendBtn = document.getElementById('sendBtn');
const messageInput = document.getElementById('messageInput');
const messagesDiv = document.getElementById('messages');
const statusMessage = document.getElementById('statusMessage');

// Элементы фильтров
const genderFilter = document.getElementById('genderFilter');
const ageFilter = document.getElementById('ageFilter');

// Поиск собеседника
findBtn.addEventListener('click', () => {
    const gender = genderFilter.value;
    const age = ageFilter.value;
    statusMessage.textContent = 'Ищем собеседника...';
    findBtn.disabled = true;
    socket.emit('find', { gender, age });
});

// Обработчики сокета
socket.on('waiting', (data) => {
    statusMessage.textContent = data.message;
    findBtn.disabled = false;
});

socket.on('connected', (data) => {
    currentRoomId = data.roomId;
    partnerId = data.partner;
    isConnected = true;
    statusMessage.textContent = '';
    findBtn.disabled = false;
    // Показать чат, скрыть главный
    mainScreen.style.display = 'none';
    chatScreen.style.display = 'block';
    messagesDiv.innerHTML = '';
    // Добавляем системное сообщение
    appendMessage('system', 'Вы соединились с собеседником! Можно писать.');
});

socket.on('message', (data) => {
    const isSelf = data.from === socket.id; // но это не придёт к нам, т.к. мы отправляем только to, но для надёжности
    // На самом деле сообщение приходит от другого, поэтому isSelf = false
    appendMessage('other', data.text, data.timestamp);
});

socket.on('partner_left', (data) => {
    appendMessage('system', data.message || 'Собеседник покинул чат.');
    // Очищаем комнату
    currentRoomId = null;
    partnerId = null;
    isConnected = false;
    // Возвращаем на главный экран
    mainScreen.style.display = 'block';
    chatScreen.style.display = 'none';
    statusMessage.textContent = 'Выберите параметры и начните снова.';
});

socket.on('disconnected', (data) => {
    // По команде next мы сами разорвали
    mainScreen.style.display = 'block';
    chatScreen.style.display = 'none';
    statusMessage.textContent = data.message || 'Вы вышли из чата.';
});

// Отправка сообщения
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !currentRoomId) return;
    // Отображаем у себя
    appendMessage('self', text);
    socket.emit('message', { roomId: currentRoomId, text });
    messageInput.value = '';
}

// Следующий собеседник
nextBtn.addEventListener('click', () => {
    if (currentRoomId) {
        socket.emit('next');
        // Сразу возвращаем на главный, но подождем ответа от сервера (disconnected)
        // Покажем статус
        statusMessage.textContent = 'Ищем нового собеседника...';
        mainScreen.style.display = 'block';
        chatScreen.style.display = 'none';
        currentRoomId = null;
        partnerId = null;
        isConnected = false;
        // Запустим поиск автоматически? По желанию, можно просто оставить на главной.
        // Лучше дать пользователю самому нажать "Начать общение".
        // Но можно автоматически запустить поиск:
        // findBtn.click(); 
        // Однако, чтобы не было конфликтов, предложу пользователю нажать кнопку.
        statusMessage.textContent = 'Нажмите "Начать общение" для поиска нового собеседника.';
    }
});

// Вспомогательная функция добавления сообщения в чат
function appendMessage(type, text, timestamp = Date.now()) {
    const div = document.createElement('div');
    div.className = `message ${type}`;
    const time = new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `${text} <span class="time">${time}</span>`;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Если пользователь закрыл страницу, ничего не делаем, сокет сам отключится