// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket'],            // יציב יותר, בלי פולינג
  allowUpgrades: true,
  pingInterval: 15000,                  // שרת שולח ping כל 15ש'
  pingTimeout: 20000,                   // נחשב ניתוק אחרי 20ש' ללא pong
});

app.use(cors());
app.use(express.json());

// קבצים סטטיים
app.use(express.static(path.join(__dirname)));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// ====== HLS (FFmpeg) ======
const LIVE_DIR = path.join(__dirname, 'live');
if (!fs.existsSync(LIVE_DIR)) fs.mkdirSync(LIVE_DIR, { recursive: true });

// ב-Render (Node) בד"כ יש ffmpeg. מקומית אפשר npm i ffmpeg-static (לא חובה)
let ffmpegPath = 'ffmpeg';
try { ffmpegPath = require('ffmpeg-static') || 'ffmpeg'; } catch (_) { /* בסדר גמור */ }

let ff = null, ffWritable = null, hlsActive = false;

function cleanOldHls() {
  try { for (const f of fs.readdirSync(LIVE_DIR)) fs.unlinkSync(path.join(LIVE_DIR, f)); } catch (_) {}
}

function startHLS() {
  if (hlsActive) return;
  cleanOldHls();
  ff = spawn(ffmpegPath, [
    '-loglevel','error',
    '-f','webm','-i','pipe:0',          // נקלט webm/opus מצ'אנקים של הדפדפן
    '-acodec','aac','-ar','48000','-b:a','96k','-ac','1',
    '-f','hls','-hls_time','2','-hls_list_size','10',
    '-hls_flags','delete_segments+append_list',
    path.join(LIVE_DIR, 'index.m3u8')
  ], { stdio: ['pipe','ignore','pipe'] });

  ffWritable = ff.stdin; hlsActive = true;

  ff.stderr.on('data', d => console.warn('ffmpeg:', d.toString()));
  ff.on('close', () => { hlsActive = false; ff = null; ffWritable = null; });
}

function pushChunkToHLS(buf) {
  if (!hlsActive || !ffWritable) return;
  try { ffWritable.write(Buffer.from(buf)); } catch(_) {}
}

function stopHLS() {
  try { ffWritable?.end(); } catch(_) {}
  try { ff?.kill('SIGINT'); } catch(_) {}
  ff = null; ffWritable = null; hlsActive = false;
}

// הגשת ה-HLS
app.use('/live', express.static(LIVE_DIR));
app.get('/live/index.m3u8', (req, res) => {
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.sendFile(path.join(LIVE_DIR, 'index.m3u8'));
});

// ====== אימות בסיסי ======
const authorizedUsers = {
  'password123': true,
  'admin': true,
  'user2024': true,
};

let connectedUsers = new Map();
let currentBroadcaster = null;

// ====== PWA manifest ======
app.get('/manifest.json', (req, res) => {
  res.json({
    "name": "PTT Voice Chat",
    "short_name": "PTT",
    "description": "Push-To-Talk voice chat application",
    "start_url": "/client.html",
    "display": "standalone",
    "background_color": "#f8f9fa",
    "theme_color": "#333333",
    "orientation": "any",
    "categories": ["communication", "social"],
    "lang": "he",
    "dir": "rtl",
    "icons": [{
      "src": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTkyIiBoZWlnaHQ9IjE5MiIgdmlld0JveD0iMCAwIDE5MiAxOTIiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjE5MiIgaGVpZ2h0PSIxOTIiIGZpbGw9IiMzMzMzMzMiIHJ4PSIyNCIvPjwvc3ZnPg==",
      "sizes": "192x192",
      "type": "image/svg+xml"
    }],
    "prefer_related_applications": false,
    "scope": "/",
    "id": "ptt-voice-chat"
  });
});

// ====== Service Worker (HTML → network-first) ======
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    const CACHE_NAME = 'ptt-chat-v3';
    const urlsToCache = [
      // בלי client.html כדי לא "לנעול" גרסה ישנה
      '/manifest.json',
      '/assets/beep.mp3'
    ];

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
            .then(resp => {
              const copy = resp.clone();
              caches.open(CACHE_NAME).then(c => c.put(event.request, copy));
              return resp;
            })
            .catch(() => caches.match(event.request))
        );
        return;
      }
      event.respondWith(caches.match(event.request).then(res => res || fetch(event.request)));
    });

    self.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'KEEP_ALIVE') {
        // no-op
      }
    });
  `);
});

// ====== עמוד ניהול ======
app.get('/admin/users', (req, res) => {
  const usersList = Object.keys(authorizedUsers);
  res.send(`
    <!DOCTYPE html><html lang="he" dir="rtl"><head>
      <title>ניהול סיסמאות - PTT</title><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;padding:30px;background:#f0f0f0;margin:0}
        .container{background:white;padding:30px;border-radius:10px;max-width:600px;margin:0 auto;box-shadow:0 4px 8px rgba(0,0,0,0.1)}
        h1{color:#333;border-bottom:2px solid #4CAF50;padding-bottom:10px}
        .info{background:#e8f4fd;padding:15px;border-radius:8px;margin:20px 0;border-left:4px solid #2196F3}
        .password-list{background:#f8f9fa;padding:20px;border-radius:8px;margin:20px 0}
        .password-item{padding:10px;margin:5px 0;background:white;border-radius:5px;font-family:monospace;font-size:1.1em;border:1px solid #e0e0e0}
        .stats{display:flex;gap:20px;margin:20px 0}
        .stat-box{flex:1;background:#f8f9fa;padding:15px;border-radius:8px;text-align:center}
        .stat-number{font-size:2em;font-weight:bold;color:#4CAF50}
        .stat-label{color:#666;margin-top:5px}
        .link{display:inline-block;padding:15px 30px;background:#4CAF50;color:#fff;text-decoration:none;border-radius:5px}
      </style>
    </head><body><div class="container">
      <h1>🔐 ניהול סיסמאות PTT</h1>
      <div class="stats">
        <div class="stat-box"><div class="stat-number">${connectedUsers.size}</div><div class="stat-label">משתמשים מחוברים</div></div>
        <div class="stat-box"><div class="stat-number">${usersList.length}</div><div class="stat-label">סיסמאות פעילות</div></div>
      </div>
      <div class="info">
        <strong>הוראות:</strong><br>• כל משתמש יכול להיכנס עם כל שם משתמש<br>• הסיסמה חייבת להיות אחת מהסיסמאות המורשות<br>• לעדכון סיסמאות - ערוך את הקובץ server.js
      </div>
      <div class="password-list">
        <h3>סיסמאות פעילות:</h3>
        ${usersList.map(p => `<div class="password-item">${p}</div>`).join('')}
      </div>
      <div style="text-align:center;margin-top:30px;">
        <a href="/client.html" class="link">חזור לאפליקציה</a>
      </div>
    </div></body></html>
  `);
});

// ====== עמוד בית ======
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><title>PTT Server</title>
    <style>body{font-family:Arial;text-align:center;padding:50px;background:#f0f0f0}
      .container{background:#fff;padding:30px;border-radius:10px;max-width:500px;margin:0 auto;box-shadow:0 4px 8px rgba(0,0,0,0.1)}
      .status{color:green;font-weight:bold;margin:20px 0}
      .link{display:inline-block;background:#4CAF50;color:#fff;padding:15px 30px;text-decoration:none;border-radius:5px;margin:10px}
    </style></head><body>
      <div class="container">
        <h1>📻 PTT Server פועל!</h1>
        <div class="status">✅ השרת פועל בהצלחה</div>
        <p>משתמשים מחוברים: ${connectedUsers.size}</p>
        <p>משדר כעת: ${currentBroadcaster ? 'כן' : 'לא'}</p>
        <h3>🚀 התחל להשתמש:</h3>
        <a href="/client.html" class="link">פתח אפליקציית PTT</a>
        <a href="/admin/users" class="link">ניהול סיסמאות</a>
        <a href="/live/index.m3u8" class="link">LIVE HLS</a>
      </div>
    </body></html>
  `);
});

// ====== Socket.IO ======
io.on('connection', (socket) => {
  console.log(`🔗 התחבר: ${socket.id}`);
  let isAuthenticated = false;

  socket.on('authenticate', ({ name, password }) => {
    if (authorizedUsers[password]) {
      isAuthenticated = true;
      connectedUsers.set(socket.id, { id: socket.id, name: name || 'משתמש', joinedAt: new Date() });
      socket.emit('auth_success');
      console.log(`✅ אומת: ${name || socket.id}`);
    } else {
      socket.emit('auth_failed', { message: 'סיסמה שגויה' });
      console.log(`❌ אימות נכשל עבור: ${name || socket.id}`);
    }
  });

  socket.on('user_join', (userData) => {
    if (!isAuthenticated) return socket.emit('auth_failed', { message: 'נדרש אימות' });
    socket.emit('connection_status', { connected: true, userId: socket.id, totalUsers: connectedUsers.size });
    io.emit('users_count', { count: connectedUsers.size });
  });

  socket.on('start_broadcast', (data) => {
    if (!isAuthenticated) return socket.emit('auth_failed', { message: 'נדרש אימות' });

    if (currentBroadcaster && currentBroadcaster !== socket.id) {
      return socket.emit('broadcast_blocked', { message: 'משתמש אחר משדר כרגע' });
    }
    currentBroadcaster = socket.id;
    const user = connectedUsers.get(socket.id);

    console.log(`🎙️ שידור החל: ${user?.name || socket.id}`);

    // התראה למאזינים + הפעלת HLS
    startHLS();
    socket.broadcast.emit('broadcast_started', {
      broadcasterId: socket.id,
      broadcasterName: user?.name || 'Unknown User',
      startTime: new Date()
    });
    socket.emit('broadcast_confirmed', { status: 'broadcasting' });
  });

  // צ'אנק חי (מומלץ)
  socket.on('audio_chunk', (buffer) => {
    if (!isAuthenticated) return;
    if (currentBroadcaster !== socket.id) return;
    if (!buffer || buffer.byteLength === 0) return;

    // לשאר הוובים:
    socket.broadcast.emit('receive_audio', {
      audioData: buffer,
      broadcasterId: socket.id,
      timestamp: Date.now(),
      size: buffer.byteLength
    });
    socket.broadcast.emit('audio_chunk', buffer);

    // ל-HLS
    pushChunkToHLS(buffer);
  });

  // בלוב בסוף (גיבוי)
  socket.on('audio_stream', (buffer) => {
    if (!isAuthenticated) return;
    if (currentBroadcaster !== socket.id) return;
    if (!buffer || buffer.byteLength === 0) return;

    socket.broadcast.emit('receive_audio', {
      audioData: buffer,
      broadcasterId: socket.id,
      timestamp: Date.now(),
      size: buffer.byteLength
    });

    // ל-HLS (כתיבה מרוכזת)
    pushChunkToHLS(buffer);
  });

  socket.on('end_broadcast', () => {
    if (!isAuthenticated) return;
    if (currentBroadcaster === socket.id) {
      currentBroadcaster = null;
      const user = connectedUsers.get(socket.id);
      console.log(`🛑 שידור הסתיים: ${user?.name || socket.id}`);

      // עצירת HLS
      stopHLS();

      socket.broadcast.emit('broadcast_ended', {
        broadcasterId: socket.id,
        broadcasterName: user?.name || 'Unknown User',
        endTime: new Date()
      });
      socket.emit('broadcast_stopped', { status: 'stopped' });
    }
  });

  socket.on('ping', () => socket.emit('pong'));
  socket.on('get_status', () => socket.emit('server_status', {
    connected: true, totalUsers: connectedUsers.size,
    currentBroadcaster, userId: socket.id
  }));

  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    console.log(`❌ התנתק: ${user?.name || socket.id}`);

    if (currentBroadcaster === socket.id) {
      currentBroadcaster = null;
      stopHLS();
      socket.broadcast.emit('broadcast_ended', {
        broadcasterId: socket.id,
        broadcasterName: user?.name || 'Unknown User',
        reason: 'disconnected'
      });
    }
    connectedUsers.delete(socket.id);
    io.emit('users_count', { count: connectedUsers.size });
  });

  socket.on('error', (err) => console.error(`שגיאה ${socket.id}:`, err));
});

server.on('error', (error) => console.error('שגיאת שרת:', error));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 שרת PTT פועל על פורט ${PORT}
📡 גישה מקומית: http://localhost:${PORT}
🌐 גישה מהרשת: http://[IP]:${PORT}
🔊 מוכן לקבל חיבורים...
📱 פתח /client.html לאפליקציה
🔐 ניהול סיסמאות: /admin/users
🎧 HLS חי: /live/index.m3u8
  `);
});
