const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const upload = multer({ dest: 'uploads/' });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/dropnel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const activeClients = {}; 
const initializingClients = {}; 

const USERS_FILE = path.join(__dirname, 'users.json');
const WITHDRAWS_FILE = path.join(__dirname, 'withdraws.json');
const SESSIONS_DIR = path.join(__dirname, 'baileys_auth');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function loadWithdraws() {
  if (!fs.existsSync(WITHDRAWS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WITHDRAWS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveWithdraws(withdraws) {
  fs.writeFileSync(WITHDRAWS_FILE, JSON.stringify(withdraws, null, 2));
}

async function initBaileysSession(phone, ownerPhone = null) {
  if (activeClients[phone]) return activeClients[phone];
  if (initializingClients[phone]) return initializingClients[phone];

  console.log(`[Baileys] Initializing WhatsApp session for +${phone}...`);

  const sessionPath = path.join(SESSIONS_DIR, `acc_${phone}`);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome')
  });

  activeClients[phone] = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log(`[Connected] WhatsApp Ready for: +${phone}`);
      delete initializingClients[phone];
      io.emit('session-updated', { phone, status: 'connected' });
    } else if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[Disconnected] +${phone} reason code: ${statusCode}`);
      
      delete activeClients[phone];
      delete initializingClients[phone];
      io.emit('session-updated', { phone, status: 'disconnected' });

      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => initBaileysSession(phone, ownerPhone), 5000);
      } else {
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) {
        const users = loadUsers();
        for (let uPhone in users) {
          if (users[uPhone].connectedNumbers && users[uPhone].connectedNumbers.includes(phone)) {
            users[uPhone].totalSent = (users[uPhone].totalSent || 0) + 1;
            users[uPhone].balance = (users[uPhone].balance || 0) + 3.00;
            saveUsers(users);
            
            io.emit(`balance-update-${uPhone}`, { balance: users[uPhone].balance, totalSent: users[uPhone].totalSent });
            break;
          }
        }
      }
    }
  });

  return sock;
}

function autoLoadExistingSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const items = fs.readdirSync(SESSIONS_DIR);

  items.forEach(item => {
    if (item.startsWith('acc_')) {
      const phone = item.replace('acc_', '');
      console.log(`[Restoring Baileys Session] Loading +${phone}...`);
      initBaileysSession(phone);
    }
  });
}

app.post('/api/auth/register', (req, res) => {
  let { phone, password, inviteCode } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: 'Phone and password are required' });
  }

  phone = phone.replace(/[^0-9]/g, '');
  const users = loadUsers();

  if (users[phone]) {
    return res.status(400).json({ error: 'User already exists' });
  }

  users[phone] = {
    password: password,
    balance: 8.00,
    inviteCode: inviteCode || '',
    connectedNumbers: [],
    totalSent: 0,
    totalWithdrawn: 0,
    createdAt: new Date().toISOString()
  };

  saveUsers(users);
  res.json({ success: true, message: 'Registration successful', balance: 8.00 });
});

app.post('/api/auth/login', (req, res) => {
  let { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: 'Phone and password are required' });
  }

  phone = phone.replace(/[^0-9]/g, '');
  const users = loadUsers();

  if (!users[phone] || users[phone].password !== password) {
    return res.status(400).json({ error: 'Invalid phone number or password' });
  }

  res.json({ success: true, message: 'Login successful', balance: users[phone].balance, user: users[phone] });
});

app.get('/api/user/numbers/:phone', (req, res) => {
  const userPhone = req.params.phone;
  const users = loadUsers();
  
  if (!users[userPhone]) return res.json({ numbers: [] });

  const userNumbers = users[userPhone].connectedNumbers || [];
  const result = userNumbers.map(num => ({
    phone: num,
    status: (activeClients[num] && activeClients[num].user) ? 'connected' : 'disconnected',
    totalSent: users[userPhone].totalSent || 0
  }));

  res.json({ numbers: result, balance: users[userPhone].balance });
});

app.post('/api/user/withdraw', (req, res) => {
  let { phone, amount, bkashNumber } = req.body;
  if (!phone || !amount || !bkashNumber) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  phone = phone.replace(/[^0-9]/g, '');
  const users = loadUsers();
  
  if (!users[phone] || users[phone].balance < parseFloat(amount)) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  users[phone].balance -= parseFloat(amount);
  users[phone].totalWithdrawn = (users[phone].totalWithdrawn || 0) + parseFloat(amount);
  saveUsers(users);

  const withdraws = loadWithdraws();
  const newWithdraw = {
    id: 'w_' + Date.now(),
    phone,
    amount: parseFloat(amount),
    bkashNumber,
    status: 'pending',
    timestamp: new Date().toISOString()
  };

  withdraws.push(newWithdraw);
  saveWithdraws(withdraws);

  io.emit('new-withdraw-request', newWithdraw);
  res.json({ success: true, balance: users[phone].balance });
});

app.post('/api/admin/withdraw-action', (req, res) => {
  const { withdrawId, action } = req.body;
  const withdraws = loadWithdraws();
  const index = withdraws.findIndex(w => w.id === withdrawId);

  if (index === -1) {
    return res.status(404).json({ success: false, error: 'Withdraw request not found' });
  }

  const withdraw = withdraws[index];
  
  if (action === 'reject') {
    const users = loadUsers();
    if (users[withdraw.phone]) {
      users[withdraw.phone].balance = (users[withdraw.phone].balance || 0) + withdraw.amount;
      users[withdraw.phone].totalWithdrawn = Math.max(0, (users[withdraw.phone].totalWithdrawn || 0) - withdraw.amount);
      saveUsers(users);
    }
    withdraw.status = 'rejected';
  } else if (action === 'approve') {
    withdraw.status = 'approved';
  }

  withdraws.splice(index, 1);
  saveWithdraws(withdraws);

  res.json({ success: true });
});

app.get('/api/admin/withdraws', (req, res) => {
  res.json({ withdraws: loadWithdraws() });
});

app.get('/api/admin/users', (req, res) => {
  res.json({ users: loadUsers() });
});

app.post('/api/request-pairing', async (req, res) => {
  let { phone, userPhone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  // নাম্বার থেকে প্লাস (+) বা অন্য কোনো স্পেশাল ক্যারেক্টার বাদ দিয়ে শুধু সংখ্যা রাখা
  phone = phone.replace(/[^0-9]/g, '');
  
  if (phone.length === 11 && phone.startsWith('0')) {
    phone = '88' + phone;
  } else if (phone.length === 10) {
    phone = '880' + phone;
  }

  if (userPhone) userPhone = userPhone.replace(/[^0-9]/g, '');

  try {
    let sock = activeClients[phone];

    if (sock && sock.user) {
      return res.json({ message: 'Already connected' });
    }

    if (!sock) {
      sock = await initBaileysSession(phone, userPhone);
    }

    if (userPhone) {
      const users = loadUsers();
      if (users[userPhone]) {
        if (!users[userPhone].connectedNumbers) {
          users[userPhone].connectedNumbers = [];
        }
        if (!users[userPhone].connectedNumbers.includes(phone)) {
          users[userPhone].connectedNumbers.push(phone);
          saveUsers(users);
        }
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    let code = null;
    if (!sock.authState.creds.registered) {
      code = await sock.requestPairingCode(phone);
    } else {
      return res.json({ message: 'Already registered' });
    }

    if (code) {
      return res.json({ code });
    } else {
      return res.status(500).json({ error: 'Pairing code generation failed' });
    }

  } catch (error) {
    console.error('Server error in pairing:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error: ' + error.message });
    }
  }
});

app.post('/api/admin/clear-all-sessions', async (req, res) => {
  try {
    for (let phone in activeClients) {
      try {
        const sock = activeClients[phone];
        if (sock && sock.end) {
          sock.end(undefined);
        }
      } catch (e) {}
    }
    
    for (let phone in activeClients) delete activeClients[phone];
    for (let phone in initializingClients) delete initializingClients[phone];

    if (fs.existsSync(SESSIONS_DIR)) {
      fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    const users = loadUsers();
    for (let uPhone in users) {
      users[uPhone].connectedNumbers = [];
    }
    saveUsers(users);

    res.json({ success: true, message: 'All sessions deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to clear sessions' });
  }
});

app.get('/api/admin/numbers', (req, res) => {
  const uniqueNumbers = Object.keys(activeClients).filter(phone => activeClients[phone]?.user);
  res.json({ numbers: uniqueNumbers });
});

app.get('/api/admin/chats/:phone', async (req, res) => {
  res.json({ chats: [] });
});

app.get('/api/admin/messages/:phone/:jid', async (req, res) => {
  res.json({ messages: [] });
});

app.post('/api/admin/send-message', async (req, res) => {
  const { senderPhone, recipientJid, text } = req.body;
  const sock = activeClients[senderPhone];

  if (!sock) return res.status(400).json({ error: 'Sender session is inactive' });

  try {
    let cleanJid = recipientJid.replace(/[^0-9]/g, '');
    const formattedJid = recipientJid.includes('@s.whatsapp.net') || recipientJid.includes('@g.us') 
      ? recipientJid 
      : `${cleanJid}@s.whatsapp.net`;

    const sentMsg = await sock.sendMessage(formattedJid, { text: text });
    res.json({ success: true, key: sentMsg.key });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.post('/api/admin/send-bulk', async (req, res) => {
  const { recipients, message } = req.body;
  const availablePhones = Object.keys(activeClients).filter(p => activeClients[p]?.user);

  if (!availablePhones.length) {
    return res.status(400).json({ error: 'No active sender accounts available in the server' });
  }

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'Recipients list is missing' });
  }

  let messagesArray = typeof message === 'string' 
    ? message.split('\n').filter(msg => msg.trim() !== '') 
    : [message];
  
  if (messagesArray.length === 0) messagesArray = [''];

  let successCount = 0;
  let failCount = 0;
  let currentSenderIndex = 0;

  for (let i = 0; i < recipients.length; i++) {
    let rawNum = recipients[i];
    let targetNum = String(rawNum).replace(/[^0-9]/g, '');
    if (!targetNum) continue;

    const formattedJid = `${targetNum}@s.whatsapp.net`;
    const currentMessage = messagesArray[i % messagesArray.length];

    let messageSent = false;
    let attempts = 0;

    while (!messageSent && attempts < availablePhones.length) {
      const activePhone = availablePhones[currentSenderIndex];
      const sock = activeClients[activePhone];

      if (!sock) {
        currentSenderIndex = (currentSenderIndex + 1) % availablePhones.length;
        attempts++;
        continue;
      }

      try {
        await sock.sendMessage(formattedJid, { text: currentMessage });
        successCount++;
        messageSent = true;
        
        currentSenderIndex = (currentSenderIndex + 1) % availablePhones.length;
        await new Promise(resolve => setTimeout(resolve, 1500));

      } catch (err) {
        currentSenderIndex = (currentSenderIndex + 1) % availablePhones.length;
        attempts++;
      }
    }

    if (!messageSent) {
      failCount++;
    }
  }

  res.json({ success: true, successCount, failCount });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Baileys Server Running] http://localhost:${PORT}`);
  autoLoadExistingSessions();
});
