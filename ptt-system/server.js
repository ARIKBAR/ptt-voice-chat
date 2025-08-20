// server.js — PTT + keepalive שקט + SW v4
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket'],
  allowUpgrades: true,
  pingInterval: 15000,
  pingTimeout: 20000,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// ===== אימות בסיסי =====
const authorizedUsers = {
  'password123': true,
  'admin': true,
  'user2024': true,
};

// ===== מצב =====
let connectedUsers = new Map();
let currentBroadcaster = null;

// ===== PWA manifest =====
app.get('/manifest.json', (req, res) => {
  res.json({
    name: "PTT Voice Chat",
    short_name: "PTT",
    description: "Push-To-Talk voice chat application",
    start_url: "/client.html",
    display: "standalone",
    background_color: "#f8f9fa",
    theme_color: "#333333",
    orientation: "any",
    categories: ["communication", "social"],
    lang: "he",
    dir: "rtl",
    icons: [{
      src: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTkyIiBoZWlnaHQ9IjE5MiIgdmlld0JveD0iMCAwIDE5MiAxOTIiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjE5MiIgaGVpZ2h0PSIxOTIiIGZpbGw9IiMzMzMzMzMiIHJ4PSIyNCIvPjwvc3ZnPg==",
      sizes: "192x192",
      type: "image/svg+xml"
    }],
    prefer_related_applications: false,
    scope: "/",
    id: "ptt-voice-chat"
  });
});

// ===== Service Worker =====
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    const CACHE_NAME = 'ptt-chat-v4'; // ← הוגדל כדי לשבור קאש ישן
    const urlsToCache = ['/manifest.json','/assets/beep.mp3'];

    self.addEventListener('install', (event) => {
      event.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(urlsToCache)));
      self.skipWaiting();
    });

    self.addEventListener('activate', (event) => {
      event.waitUntil(
        caches.keys().then(keys =>
          Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
      );
    });

    self.addEventListener('fetch', (event) => {
      if (event.request.url.includes('/socket.io/')) return;
      const acceptsHtml = event.request.headers.get('accept')?.includes('text/html');
      const isNavigate = event.request.mode === 'navigate';

      if (isNavigate || acceptsHtml) {
        event.respondWith(
          fetch(event.request)
            .then((resp) => {
              const copy = resp.clone();
              caches.open(CACHE_NAME).then(c => c.put(event.request, copy));
              return resp;
            })
            .catch(() => caches.match(event.request) || caches.match('/client.html'))
        );
        return;
      }
      event.respondWith(caches.match(event.request).then(res => res || fetch(event.request)));
    });

    self.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'KEEP_ALIVE') {}
    });
  `);
});

// ===== אין קאש ל־client.html =====
app.get('/client.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'client.html'));
});

// ===== עמוד אדמין =====
app.get('/admin/users', (req, res) => {
  const usersList = Object.keys(authorizedUsers);
  res.send(`
    <!DOCTYPE html><html lang="he" dir="rtl"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>ניהול סיסמאות - PTT</title>
      <style>
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;padding:30px;background:#f0f0f0;margin:0}
        .container{background:#fff;padding:30px;border-radius:10px;max-width:600px;margin:0 auto;box-shadow:0 4px 8px rgba(0,0,0,.1)}
        h1{color:#333;border-bottom:2px solid #4CAF50;padding-bottom:10px}
        .password-item{padding:10px;margin:5px 0;background:#fff;border-radius:5px;font-family:monospace;border:1px solid #e0e0e0}
      </style></head><body>
        <div class="container">
          <h1>🔐 ניהול סיסמאות PTT</h1>
          <div>משתמשים מחוברים: ${connectedUsers.size}</div>
          <div>סיסמאות פעילות:</div>
          ${usersList.map(p => `<div class="password-item">${p}</div>`).join('')}
          <p><a href="/client.html">חזור לאפליקציה</a></p>
        </div>
    </body></html>
  `);
});

// ===== עמוד בית =====
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><title>PTT Server</title>
    <style>body{font-family:Arial;text-align:center;padding:50px;background:#f0f0f0}.container{background:#fff;padding:30px;border-radius:10px;max-width:500px;margin:0 auto;box-shadow:0 4px 8px rgba(0,0,0,.1)}.link{display:inline-block;background:#4CAF50;color:#fff;padding:15px 30px;text-decoration:none;border-radius:5px;margin:10px}</style>
    </head><body><div class="container">
      <h1>📻 PTT Server פועל!</h1>
      <p>משתמשים מחוברים: ${connectedUsers.size}</p>
      <p>משדר כעת: ${currentBroadcaster ? 'כן' : 'לא'}</p>
      <p><a class="link" href="/client.html">פתח אפליקציית PTT</a>
         <a class="link" href="/admin/users">ניהול סיסמאות</a></p>
    </div></body></html>
  `);
});

// ===== Socket.IO =====
io.on('connection', (socket) => {
  console.log(`🔗 משתמש חדש: ${socket.id}`);
  let isAuthenticated = false;
  let authenticatedUser = null;

  socket.on('client_ping', () => socket.emit('server_pong', Date.now()));

  // אימות
  socket.on('authenticate', (data = {}) => {
    const { name, password } = data;
    if (authorizedUsers[password]) {
      isAuthenticated = true;
      authenticatedUser = name || `user-${socket.id.slice(0, 5)}`;
      connectedUsers.set(socket.id, { id: socket.id, name: authenticatedUser, joinedAt: new Date() });
      socket.emit('auth_success');
      console.log(`✅ אומת: ${authenticatedUser}`);
      io.emit('users_count', { count: connectedUsers.size });
    } else {
      socket.emit('auth_failed', { message: 'סיסמה שגויה' });
      console.log(`❌ אימות נכשל עבור: ${name}`);
    }
  });

  // הצטרפות
  socket.on('user_join', () => {
    if (!isAuthenticated) return socket.emit('auth_failed', { message: 'נדרש אימות' });
    io.emit('users_count', { count: connectedUsers.size });
  });

  // התחלת שידור
  socket.on('start_broadcast', () => {
    if (!isAuthenticated) return socket.emit('auth_failed', { message: 'נדרש אימות' });
    if (currentBroadcaster && currentBroadcaster !== socket.id) {
      return socket.emit('broadcast_blocked', { message: 'משתמש אחר משדר כרגע' });
    }
    currentBroadcaster = socket.id;
    const user = connectedUsers.get(socket.id);
    console.log(`🎙️ שידור החל: ${user?.name || socket.id}`);
    socket.broadcast.emit('broadcast_started', {
      broadcasterId: socket.id,
      broadcasterName: user?.name || 'Unknown',
      startTime: new Date()
    });
    socket.emit('broadcast_confirmed', { status: 'broadcasting' });
  });

  // צ'אנקי אודיו
  socket.on('audio_chunk', (buffer) => {
    if (!isAuthenticated || currentBroadcaster !== socket.id) return;
    if (!buffer || buffer.byteLength === 0) return;
    socket.broadcast.emit('receive_audio', {
      audioData: buffer,
      broadcasterId: socket.id,
      timestamp: Date.now(),
      size: buffer.byteLength
    });
  });

  // fallback לבלוב יחיד
  socket.on('audio_stream', (buffer) => {
    if (!isAuthenticated || currentBroadcaster !== socket.id) return;
    if (!buffer || buffer.byteLength === 0) return;
    socket.broadcast.emit('receive_audio', {
      audioData: buffer,
      broadcasterId: socket.id,
      timestamp: Date.now(),
      size: buffer.byteLength
    });
  });

  // סיום שידור
  socket.on('end_broadcast', () => {
    if (!isAuthenticated) return;
    if (currentBroadcaster === socket.id) {
      currentBroadcaster = null;
      const user = connectedUsers.get(socket.id);
      console.log(`🛑 שידור הסתיים: ${user?.name || socket.id}`);
      socket.broadcast.emit('broadcast_ended', {
        broadcasterId: socket.id,
        broadcasterName: user?.name || 'Unknown',
        endTime: new Date()
      });
      socket.emit('broadcast_stopped', { status: 'stopped' });
    }
  });

  // ניתוק
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    console.log(`❌ התנתק: ${user?.name || socket.id}`);
    if (currentBroadcaster === socket.id) {
      currentBroadcaster = null;
      socket.broadcast.emit('broadcast_ended', { broadcasterId: socket.id, reason: 'disconnected' });
    }
    connectedUsers.delete(socket.id);
    io.emit('users_count', { count: connectedUsers.size });
  });
});

// ====== keepalive שקט כל ~דקה ======
function createWavSilence(durationMs = 200, sampleRate = 44100) {
  const numSamples = Math.floor(sampleRate * durationMs / 1000);
  const bytesPerSample = 2; // 16-bit mono
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  // גוף הנתונים שקט (אפסים)

  return buffer;
}
const SILENT_WAV = createWavSilence(200);
const KEEPALIVE_INTERVAL_MS = 60000;
let keepAliveTimer = null;

function scheduleKeepAlive() {
  clearTimeout(keepAliveTimer);
  const jitter = Math.floor(Math.random() * 8000) - 4000; // ±4s
  keepAliveTimer = setTimeout(doKeepAlive, Math.max(30000, KEEPALIVE_INTERVAL_MS + jitter));
}
function doKeepAlive() {
  try {
    if (currentBroadcaster) return scheduleKeepAlive();
    if (connectedUsers.size === 0) return scheduleKeepAlive();

    io.emit('broadcast_started', {
      broadcasterId: 'system',
      broadcasterName: 'system',
      system: true,
      startTime: new Date()
    });

    io.emit('receive_audio', {
      audioData: SILENT_WAV,
      broadcasterId: 'system',
      system: true,
      timestamp: Date.now(),
      size: SILENT_WAV.length
    });

    setTimeout(() => {
      io.emit('broadcast_ended', {
        broadcasterId: 'system',
        system: true,
        endTime: new Date()
      });
      scheduleKeepAlive();
    }, 300);
  } catch (e) {
    scheduleKeepAlive();
  }
}
scheduleKeepAlive();

server.on('error', (error) => console.error('שגיאת שרת:', error));
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 שרת PTT פועל על פורט ${PORT}\n📱 פתח /client.html לאפליקציה`);
});
