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

// সেশন ও ক্লায়েন্ট স্টোর
const activeClients = {}; // Active puppeteer instances
const initializingClients = {}; // Pending initialization promises

// সেশন ডিরেক্টরি
const SESSIONS_DIR = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * Puppeteer Client ইনিশিয়ালাইজ করার সুরক্ষিত ফাংশন
 */
async function initPuppeteerSession(phone) {
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

  client.on('message', async (msg) => {
    const jid = msg.from;
    let mediaData = null;
    let mediaType = null;

    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          mediaData = `data:${media.mimetype};base64,${media.data}`;
          if (media.mimetype.startsWith('image/')) mediaType = 'image';
          else if (media.mimetype.startsWith('audio/')) mediaType = 'audio';
          else mediaType = 'document';
        }
      } catch (err) {
        console.error('Media download error:', err);
      }
    }

    io.emit('new-message', {
      senderPhone: phone,
      fromJid: jid,
      messageKey: { id: msg.id.id, remoteJid: jid, fromMe: msg.fromMe },
      fromMe: msg.fromMe,
      text: msg.body || '',
      mediaData: mediaData,
      mediaType: mediaType,
      timestamp: msg.timestamp
    });
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

app.post('/api/request-pairing', async (req, res) => {
  let { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  phone = phone.replace(/[^0-9]/g, '');

  try {
    let client = activeClients[phone];

    if (client && client.info) {
      return res.json({ message: 'Already registered' });
    }

    if (!client) {
      client = await initPuppeteerSession(phone);
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

/**
 * নতুন বাল্ক সেন্ডার এন্ডপয়েন্ট: মাল্টি-নম্বর ফলব্যাক (Failover) লজিক
 */
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

    // যতক্ষণ না মেসেজ সেন্ড হয় অথবা সব সেশন ফেল করে, চেষ্টা চালিয়ে যাবে
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
        // বর্তমান সেশনে সমস্যা বা লিমি트 শেষ হলে পরবর্তী সেশনে সুইচ করা হবে
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

app.post('/api/admin/send-media', upload.single('file'), async (req, res) => {
  const { senderPhone, recipientJid, caption } = req.body;
  const file = req.file;
  const client = activeClients[senderPhone];

  if (!client || !file) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: 'Session or file is missing' });
  }

  try {
    const formattedJid = recipientJid.includes('@c.us') || recipientJid.includes('@g.us') 
      ? recipientJid 
      : `${recipientJid}@c.us`;

    const media = MessageMedia.fromFilePath(file.path);
    const sentMsg = await client.sendMessage(formattedJid, media, { caption: caption || '' });

    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    res.json({ success: true, key: { id: sentMsg.id.id, remoteJid: formattedJid } });
  } catch (error) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    console.error('Send media error:', error);
    res.status(500).json({ error: 'Failed to send media file' });
  }
});

app.post('/api/admin/edit-message', async (req, res) => {
  const { senderPhone, recipientJid, key, newText } = req.body;
  const client = activeClients[senderPhone];

  if (!client) return res.status(400).json({ error: 'Session inactive' });

  try {
    const chat = await client.getChatById(recipientJid);
    const msgs = await chat.fetchMessages({ limit: 20 });
    const targetId = typeof key === 'object' ? key.id : key;
    const msgToEdit = msgs.find(m => m.id.id === targetId);

    if (msgToEdit) {
      await msgToEdit.edit(newText);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Message not found to edit' });
    }
  } catch (error) {
    console.error('Edit error:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

app.post('/api/admin/delete-message', async (req, res) => {
  const { senderPhone, recipientJid, key } = req.body;
  const client = activeClients[senderPhone];

  if (!client) return res.status(400).json({ error: 'Session inactive' });

  try {
    const chat = await client.getChatById(recipientJid);
    const msgs = await chat.fetchMessages({ limit: 20 });
    const targetId = typeof key === 'object' ? key.id : key;
    const msgToDelete = msgs.find(m => m.id.id === targetId);

    if (msgToDelete) {
      await msgToDelete.delete(true);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Message not found' });
    }
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Puppeteer Server Running] http://localhost:${PORT}`);
  autoLoadExistingSessions();
});
      
