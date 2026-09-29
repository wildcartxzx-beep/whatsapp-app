const express = require('express');
const http = http = require('http'); // Fixed variable syntax
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

// সেশন ও ক্লায়েন্ট স্টোর
const activeClients = {}; 
const initializingClients = {}; 

// ডেটা ফাইল পাথ
const USERS_FILE = path.join(__dirname, 'users.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DEPOSITS_FILE = path.join(__dirname, 'deposits.json');

// সেশন ডিরেক্টরি
const SESSIONS_DIR = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ইউজার ডাটা লোড ও সেভ করার ফাংশন
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

// সেটিংস (বিকাশ নম্বর) লোড ও সেভ করার ফাংশন
function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    const defaultSettings = { bkashNumber: '01700000000' };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2));
    return defaultSettings;
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    return { bkashNumber: '01700000000' };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ডিপোজিট রিকোয়েস্ট লোড ও সেভ করার ফাংশন
function loadDeposits() {
  if (!fs.existsSync(DEPOSITS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DEPOSITS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveDeposits(deposits) {
  fs.writeFileSync(DEPOSITS_FILE, JSON.stringify(deposits, null, 2));
}

/**
 * Puppeteer Client ইনিশিয়ালাইজ করার সুরক্ষিত ফাংশন (ওনার ফোন নম্বর ট্র্যাকসহ)
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

  // মেসেজ সেন্ড হলে ইউজারের একাউন্টে কাউন্ট এবং ব্যালেন্স যোগ করার লজিক
  client.on('message', async (msg) => {
    if (msg.fromMe) {
      const users = loadUsers();
      // যে ইউজারের আন্ডারে এই নম্বর কানেক্টেড তাকে খুঁজে বের করা
      for (let uPhone in users) {
        if (users[uPhone].connectedNumbers && users[uPhone].connectedNumbers.includes(phone)) {
          users[uPhone].totalSent = (users[uPhone].totalSent || 0) + 1;
          users[uPhone].balance = (users[uPhone].balance || 0) + 0.50; // প্রতি মেসেজে ব্যালেন্স যোগ (আপনার প্রয়োজনমতো পরিবর্তন করতে পারেন)
          saveUsers(users);
          
          // রিয়েল-টাইমে ইউজারের ফ্রন্টএন্ডে ব্যালেন্স আপডেট পাঠানো
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

// ------------------- API Endpoints -------------------

// ১. ইউজার রেজিস্ট্রেশন
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
    createdAt: new Date().toISOString()
  };

  saveUsers(users);
  res.json({ success: true, message: 'Registration successful', balance: 8.00 });
});

// ২. ইউজার লগইন
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

// ৩. নির্দিষ্ট ইউজারের কানেক্টেড নম্বরগুলোর স্ট্যাটাস ও ডিটেইলস ফেচ করা
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

// ৪. ইউজার কর্তৃক ডিপোজিট রিকোয়েস্ট সাবমিট করা
app.post('/api/user/deposit', (req, res) => {
  let { phone, amount, trxId } = req.body;
  if (!phone || !amount || !trxId) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  phone = phone.replace(/[^0-9]/g, '');
  const deposits = loadDeposits();

  const newDeposit = {
    phone,
    amount: parseFloat(amount),
    trxId,
    status: 'pending',
    timestamp: new Date().toISOString()
  };

  deposits.push(newDeposit);
  saveDeposits(deposits);

  // এডমিন প্যানেলে রিয়েল-টাইমে ডিপোজিট রিকোয়েস্ট পাঠানোর জন্য Socket.io ইভেন্ট
  io.emit('new-deposit-admin', newDeposit);

  res.json({ success: true, message: 'Deposit request submitted successfully' });
});

// ৫. এডমিন প্যানেলের জন্য সমস্ত ডিপোজিট রিকোয়েস্ট দেখা
app.get('/api/admin/deposits', (req, res) => {
  const deposits = loadDeposits();
  res.json({ deposits });
});

// ৬. ডাইনামিক বিকাশ নম্বর ফেচ করা
app.get('/api/admin/get-bkash', (req, res) => {
  const settings = loadSettings();
  res.json({ bkashNumber: settings.bkashNumber });
});

// ৭. এডমিন প্যানেল থেকে বিকাশ নম্বর আপডেট করা
app.post('/api/admin/update-bkash', (req, res) => {
  const { bkashNumber } = req.body;
  if (!bkashNumber) {
    return res.status(400).json({ error: 'Bkash number is required' });
  }

  const settings = loadSettings();
  settings.bkashNumber = bkashNumber;
  saveSettings(settings);

  io.emit('update-bkash-number', bkashNumber);
  res.json({ success: true, message: 'Bkash number updated successfully', bkashNumber });
});

// ৮. পেয়ারিং কোড রিকোয়েস্ট এবং ইউজারের সাথে নম্বর বাইন্ডিং
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

    // নির্দিষ্ট ইউজারের ডাটাবেজে কানেক্টেড নম্বরটি সেভ করা
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

app.post('/api/admin/send-bulk', async (req, res) => {
  const { recipients, message } = req.body;
  const availablePhones = Object.keys(activeClients);

  if (!availablePhones.length) {
    return res.status(400).json({ error: 'No active sender accounts available in the server' });
  }

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'Recipients list is missing' });
  }

  let successCount = 0;
  let failCount = 0;
  let currentSenderIndex = 0;

  for (let rawNum of recipients) {
    let targetNum = rawNum.replace(/[^0-9]/g, '');
    if (!targetNum) continue;

    const formattedJid = `${targetNum}@c.us`;
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
        await client.sendMessage(formattedJid, message);
        successCount++;
        messageSent = true;
        console.log(`[Bulk Success] Sent to ${targetNum} using session +${activePhone}`);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Puppeteer Server Running] http://localhost:${PORT}`);
  autoLoadExistingSessions();
});
        
