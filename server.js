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

  // ক্লায়েন্ট সেভ করে রাখা
  activeClients[phone] = client;

  // রেডিনেস ইভেন্ট
  client.on('ready', async () => {
    console.log(`[Connected] WhatsApp Web Ready for: +${phone}`);
    io.emit('session-updated', { phone, status: 'connected' });
  });

  // ডিসকানেক্ট ইভেন্ট
  client.on('disconnected', (reason) => {
    console.log(`[Disconnected] +${phone} reason: ${reason}`);
    delete activeClients[phone];
    delete initializingClients[phone];
    io.emit('session-updated', { phone, status: 'disconnected' });
  });

  // ইনকামিং মেসেজ হ্যান্ডলিং
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

/**
 * সার্ভার স্টার্টে আগে থেকে সেভ থাকা সেশন অটো-লোডিং
 */
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

/**
 * পেয়ারিং কোড রিকোয়েস্ট
 */
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
          // ৩ সেকেন্ড সামান্য সময় দেওয়া যাতে সেশন পেয়ারিংয়ের জন্য প্রস্তুত হয়
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

    // ২৫ সেকেন্ডে রেসপন্স না আসলে সেফটি টাইমআউট
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

/**
 * এডমিন API - একটিভ নম্বর তালিকা
 */
app.get('/api/admin/numbers', (req, res) => {
  res.json({ numbers: Object.keys(activeClients) });
});

/**
 * এডমিন API - চ্যাট লিস্ট
 */
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

/**
 * এডমিন API - মেসেজ হিস্ট্রি
 */
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

/**
 * এডমিন API - টেক্সট মেসেজ সেন্ড
 */
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
 * এডমিন API - মিডিয়া সেন্ড
 */
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

/**
 * এডমিন API - মেসেজ এডিট
 */
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

/**
 * এডমিন API - মেসেজ ডিলিট
 */
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

// সার্ভার স্টার্ট
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Puppeteer Server Running] http://localhost:${PORT}`);
  autoLoadExistingSessions();
});
