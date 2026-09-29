const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const upload = multer({ dest: 'uploads/' });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// এডমিন প্যানেল রাউট (dropnel)[cite: 6]
app.get('/dropnel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// সেশন ও ক্লায়েন্ট স্টোর[cite: 6]
const activeClients = {}; 
const initializingClients = {}; 

// ডেটা ফাইল পাথ[cite: 6]
const USERS_FILE = path.join(__dirname, 'users.json');
const WITHDRAWS_FILE = path.join(__dirname, 'withdraws.json');

// সেশন ডিরেক্টরি[cite: 6]
const SESSIONS_DIR = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ইউজার ডাটা লোড ও সেভ করার ফাংশন[cite: 6]
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

// উইথড্রল রিকোয়েস্ট লোড ও সেভ করার ফাংশন[cite: 6]
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

/**
 * Puppeteer Client ইনিশিয়ালাইজ করার সুরক্ষিত ফাংশন[cite: 6]
 */
async function initPuppeteerSession(phone, ownerPhone = null) {
  if (activeClients[phone]) return activeClients[phone];
  if (initializingClients[phone]) return initializingClients[phone];

  console.log(`[Puppeteer] Initializing WhatsApp Web for +${phone}...`);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `acc_${phone}`,
      dataPath: SESSIONS_DIR
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  activeClients[phone] = client;

  client.on('ready', async () => {
    console.log(`[Connected] WhatsApp Web Ready for: +${phone}`);
    io.emit('session-updated', { phone, status: 'connected' });
  });

  client.on('disconnected', (reason) => {
    console.log(`[Disconnected] +${phone} reason: ${reason}`);
    delete activeClients[phone];
    delete initializingClients[phone];
    io.emit('session-updated', { phone, status: 'disconnected' });
  });

  // প্রতি মেসেজ সেন্ড হলে ইউজারের একাউন্টে ৩ টাকা যোগ হওয়ার লজিক[cite: 6]
  client.on('message', async (msg) => {
    if (msg.fromMe) {
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
  });

  initializingClients[phone] = client.initialize().catch(err => {
    console.error(`[Puppeteer Init Error] +${phone}:`, err);
    delete activeClients[phone];
    delete initializingClients[phone];
  });

  return client;
}

function autoLoadExistingSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const items = fs.readdirSync(SESSIONS_DIR);

  items.forEach(item => {
    if (item.startsWith('session-acc_')) {
      const phone = item.replace('session-acc_', '');
      console.log(`[Restoring Puppeteer Session] Loading +${phone}...`);
      initPuppeteerSession(phone);
    }
  });
}

// ------------------- API Endpoints -------------------[cite: 6]

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
    status: (activeClients[num] && activeClients[num].info) ? 'connected' : 'disconnected',
    totalSent: users[userPhone].totalSent || 0
  }));

  res.json({ numbers: result, balance: users[userPhone].balance });
});

// ইউজার উইথড্র রিকোয়েস্ট[cite: 6]
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

// এডমিন উইথড্র অ্যাকশন[cite: 6]
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

  phone = phone.replace(/[^0-9]/g, '');
  if (userPhone) userPhone = userPhone.replace(/[^0-9]/g, '');

  try {
    let client = activeClients[phone];

    if (client && client.info) {
      return res.json({ message: 'Already registered' });
    }

    if (!client) {
      client = await initPuppeteerSession(phone, userPhone);
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

    let pairingCodeSent = false;

    const qrHandler = async () => {
      if (!pairingCodeSent) {
        try {
          setTimeout(async () => {
            try {
              const code = await client.requestPairingCode(phone);
              pairingCodeSent = true;
              if (!res.headersSent) {
                return res.json({ code });
              }
            } catch (err) {
              console.error('Pairing code request error:', err);
              if (!res.headersSent) {
                return res.status(500).json({ error: 'Pairing code generation failed' });
              }
            }
          }, 3000);
        } catch (err) {
          console.error('Error triggering pairing:', err);
        }
      }
    };

    client.once('qr', qrHandler);

    setTimeout(() => {
      client.removeListener('qr', qrHandler);
      if (!pairingCodeSent && !res.headersSent) {
        res.status(500).json({ error: 'Timeout waiting for pairing code' });
      }
    }, 25000);

  } catch (error) {
    console.error('Server error in pairing:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

app.get('/api/admin/numbers', (req, res) => {
  res.json({ numbers: Object.keys(activeClients) });
});

app.get('/api/admin/chats/:phone', async (req, res) => {
  const phone = req.params.phone;
  const client = activeClients[phone];

  if (!client) return res.json({ chats: [] });

  try {
    const chats = await client.getChats();
    const chatList = chats.map(c => ({
      jid: c.id._serialized,
      name: c.name || c.id.user
    }));
    res.json({ chats: chatList });
  } catch (error) {
    res.json({ chats: [] });
  }
});

app.get('/api/admin/messages/:phone/:jid', async (req, res) => {
  const { phone, jid } = req.params;
  const client = activeClients[phone];

  if (!client) return res.json({ messages: [] });

  try {
    const chat = await client.getChatById(jid);
    const fetchedMsgs = await chat.fetchMessages({ limit: 50 });

    const msgs = await Promise.all(fetchedMsgs.map(async (m) => {
      let mediaData = null;
      let mediaType = null;

      if (m.hasMedia) {
        try {
          const media = await m.downloadMedia();
          if (media) {
            mediaData = `data:${media.mimetype};base64,${media.data}`;
            if (media.mimetype.startsWith('image/')) mediaType = 'image';
            else if (media.mimetype.startsWith('audio/')) mediaType = 'audio';
            else mediaType = 'document';
          }
        } catch (err) {}
      }

      return {
        text: m.body || '',
        fromMe: m.fromMe,
        key: { id: m.id.id, remoteJid: jid, fromMe: m.fromMe },
        mediaData,
        mediaType,
        timestamp: m.timestamp
      };
    }));

    res.json({ messages: msgs });
  } catch (error) {
    res.json({ messages: [] });
  }
});

app.post('/api/admin/send-message', async (req, res) => {
  const { senderPhone, recipientJid, text } = req.body;
  const client = activeClients[senderPhone];

  if (!client) return res.status(400).json({ error: 'Sender session is inactive' });

  try {
    const formattedJid = recipientJid.includes('@c.us') || recipientJid.includes('@g.us') 
      ? recipientJid 
      : `${recipientJid}@c.us`;

    const sentMsg = await client.sendMessage(formattedJid, text);
    res.json({ success: true, key: { id: sentMsg.id.id, remoteJid: formattedJid } });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// মাল্টি-অ্যাকাউন্ট এবং মাল্টি-মেসেজ রাউন্ড-রবিন বাল্ক সেন্ডিং লজিক[cite: 6]
app.post('/api/admin/send-bulk', async (req, res) => {
  const { recipients, message } = req.body;
  const availablePhones = Object.keys(activeClients);

  if (!availablePhones.length) {
    return res.status(400).json({ error: 'No active sender accounts available in the server' });
  }

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'Recipients list is missing' });
  }

  // মেসেজগুলোকে নতুন লাইন অনুযায়ী ভেঙে অ্যারে তৈরি করা (একাধিক মেসেজ সাপোর্টের জন্য)[cite: 6]
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

    const formattedJid = `${targetNum}@c.us`;
    
    // রাউন্ড-রবিন পদ্ধতিতে প্রতিটি রিসিভারের জন্য ভিন্ন ভিন্ন মেসেজ সিলেক্ট করা[cite: 6]
    const currentMessage = messagesArray[i % messagesArray.length];

    let messageSent = false;
    let attempts = 0;

    while (!messageSent && attempts < availablePhones.length) {
      const activePhone = availablePhones[currentSenderIndex];
      const client = activeClients[activePhone];

      if (!client) {
        currentSenderIndex = (currentSenderIndex + 1) % availablePhones.length;
        attempts++;
        continue;
      }

      try {
        await client.sendMessage(formattedJid, currentMessage);
        successCount++;
        messageSent = true;
        console.log(`[Bulk Success] Sent to ${targetNum} using session +${activePhone}`);
        
        // অ্যাকাউন্ট রোটেশন আপডেট[cite: 6]
        currentSenderIndex = (currentSenderIndex + 1) % availablePhones.length;

        // অ্যান্টি-স্প্যাম বা ব্যান রোধ করতে প্রতিটি মেসেজের মাঝে ১.৫ সেকেন্ড বিরতি[cite: 6]
        await new Promise(resolve => setTimeout(resolve, 1500));

      } catch (err) {
        console.warn(`[Bulk Fail/Limit] Session +${activePhone} failed. Switching to next session...`);
        currentSenderIndex = (currentSenderIndex + 1) % availablePhones.length;
        attempts++;
      }
    }

    if (!messageSent) {
      failCount++;
      console.error(`[Bulk Error] Failed to send message to ${targetNum} across all sessions.`);
    }
  }

  res.json({ success: true, successCount, failCount });
});

// ক্লিন ইউআরএলের জন্য ক্যাচ-অল রাউট (এটি স্ট্যাটিক ফোল্ডারের পরে দিতে হবে)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Puppeteer Server Running] http://localhost:${PORT}`);
  autoLoadExistingSessions();
});
