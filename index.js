const express = require('express');
const app = express();
const path = require('path');

let chatHistory = [];
// --- 新增：用来存储抓取到的表格 HTML ---
let latestStatusHtml = ''; 
// ------------------------------------
let queuedMessages = [];
let teamChatHistory = [];
const onlineUsers = new Map(); // username -> lastActive timestamp
const userProfiles = new Map(); // username -> { name, description, avatar, color }
const USER_TIMEOUT = 10 * 1000; // 10 seconds timeout

// Increase body limit to support large chat history
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Logging middleware
app.use((req, res, next) => {
    // 过滤掉频繁的请求日志，不然控制台太乱了
    if (!req.url.includes('get-chat') && !req.url.includes('heartbeat')) {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    }
    next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// --- User Management (保持不变) ---
setInterval(() => {
    const now = Date.now();
    for (const [username, lastActive] of onlineUsers.entries()) {
        if (now - lastActive > USER_TIMEOUT) {
            onlineUsers.delete(username);
        }
    }
}, 5000);

app.post('/login', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).send('Username is required');
    onlineUsers.set(username, Date.now());
    if (!userProfiles.has(username)) {
        userProfiles.set(username, {
            name: username,
            description: 'No description yet.',
            avatar: '',
            color: '#'+Math.floor(Math.random()*16777215).toString(16)
        });
    }
    console.log(`User ${username} logged in`);
    res.json({ success: true, profile: userProfiles.get(username) });
});

app.post('/update-profile', (req, res) => {
    const { username, name, description, avatar } = req.body;
    if (!username) return res.status(400).send('Username required');
    const currentProfile = userProfiles.get(username) || {};
    userProfiles.set(username, { ...currentProfile, name: name || currentProfile.name, description: description || '', avatar: avatar || '' });
    onlineUsers.set(username, Date.now());
    res.json({ success: true });
});

app.get('/get-profiles', (req, res) => {
    const onlineProfiles = {};
    for (const [user, _] of onlineUsers) {
        if (userProfiles.has(user)) onlineProfiles[user] = userProfiles.get(user);
    }
    res.json(onlineProfiles);
});

app.post('/heartbeat', (req, res) => {
    const { username } = req.body;
    if (username) onlineUsers.set(username, Date.now());
    res.json({ onlineUsers: Array.from(onlineUsers.keys()) });
});

// --- Team Chat (保持不变) ---
app.get('/get-team-chat', (req, res) => { res.json(teamChatHistory); });

function handleDiceRoll(message) {
    const match = message.match(/^(\/roll|\/r)\s+(\d+)d(\d+)(\+(\d+))?/i);
    if (match) {
        const count = parseInt(match[2]), sides = parseInt(match[3]), bonus = match[5] ? parseInt(match[5]) : 0;
        if (count > 100 || sides > 1000) return null;
        let total = 0, rolls = [];
        for (let i = 0; i < count; i++) {
            const roll = Math.floor(Math.random() * sides) + 1;
            rolls.push(roll);
            total += roll;
        }
        total += bonus;
        return { total, details: `[ ${rolls.join(', ')} ]` + (bonus ? ` + ${bonus}` : ''), original: message };
    }
    return null;
}

app.post('/send-team-chat', (req, res) => {
    const { username, message } = req.body;
    if (!username || !message) return res.status(400).send('Missing data');
    const diceResult = handleDiceRoll(message);
    if (diceResult) {
        teamChatHistory.push({ id: Date.now(), username, message: message, timestamp: new Date().toISOString(), isCommand: true });
        teamChatHistory.push({ id: Date.now() + 1, username: 'System', message: `🎲 ${username} rolled ${diceResult.total} (${diceResult.details})`, timestamp: new Date().toISOString(), isSystem: true });
    } else {
        teamChatHistory.push({ id: Date.now(), username, message, timestamp: new Date().toISOString() });
    }
    if (teamChatHistory.length > 100) teamChatHistory = teamChatHistory.slice(-100);
    res.send('Team message received');
});

// --- AI Chat (这里是核心修改部分) ---

app.post('/set-chat', (req, res) => {
    const body = req.body;

    // 情况 1: 新版插件发送的数据 (对象，包含 chat 和 extra_html)
    if (body && body.chat && Array.isArray(body.chat)) {
        chatHistory = body.chat;
        // 保存抓取到的 HTML，如果没有则存为空字符串
        latestStatusHtml = body.extra_html || ''; 
        console.log(`Received chat history (${chatHistory.length} msgs) and Status Data.`);
    } 
    // 情况 2: 旧版兼容 (只发送了数组)
    else if (Array.isArray(body)) {
        chatHistory = body;
        console.log(`Received legacy chat history. ${chatHistory.length} messages.`);
    } 
    else {
        console.log('Received invalid chat history format');
    }
    res.send('Chat history received');
});

app.get('/get-chat', (req, res) => {
    // 修改返回格式！
    // 以前直接返回 chatHistory 数组
    // 现在返回一个对象 { chat: [], extra_html: "" }
    // 注意：这会导致你现在的网页前端报错，直到我们把前端 JS 也改好
    res.json({
        chat: chatHistory || [],
        extra_html: latestStatusHtml || ''
    });
});

app.post('/queue-message', (req, res) => {
    queuedMessages.push(req.body);
    console.log('Queued message:', req.body);
    res.send('Message queued successfully');
});

app.get('/queued-messages', (req, res) => {
    res.json(queuedMessages);
    queuedMessages = [];
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).send('Internal Server Error');
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Local URL: http://localhost:${PORT}`);
});