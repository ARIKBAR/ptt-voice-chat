// server.js (Merged & Upgraded)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket'],            // יציב יותר במובייל
  allowUpgrades: true,
  pingInterval: 15000,                  // שרת שולח ping כל 15ש'
  pingTimeout: 20000,                   // נחשב ניתוק אחרי 20ש' ללא pong
});

app.use(cors());
app.use(express.json());

// סטטיים
app.use(express.static(path.join(__dirname)));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// ===== אימות בסיס סיסמאות (כמו אצלך) =====
const authorizedUsers = {
  'password123': true,
  'admin': true,
  'user2024': true,
  // הוסף/י עוד לפי הצורך
};

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

// ===== Service Worker (משודרג) =====
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    const CACHE_NAME = 'ptt-chat-v3';
    const urlsToCache = [
      // בכוונה לא מכניסים /client.html כדי לא "לנעול" גרסה ישנה
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
      if (event.request.url.includes('/socket.io/')) return; // לא להתערב ב-WS

      const acceptsHtml = event.request.headers.get('accept')?.includes('text/html');
      const isNavigate = event.request.mode === 'navigate';

      // HTML → network-first
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

      // סטטיים → cache-first
      event.respondWith(caches.match(event.request).then(res => res || fetch(event.request)));
    });

    self.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'KEEP_ALIVE') {
        // no-op
      }
    });
  `);
});

// ===== client.html ללא cache ברמת HTTP =====
app.get('/client.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'client.html'));
});

// ===== עמוד אדמין (ללא שינוי מהותי) =====
app.get('/admin/users', (req, res) => {
  const usersList = Object.keys(authorizedUsers);
  res.send(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <title>ניהול סיסמאות - PTT</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; padding: 30px; background: #f0f0f0; margin: 0; }
            .container { background: white; padding: 30px; border-radius: 10px; max-width: 600px; margin: 0 auto; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
            h1 { color: #333; border-bottom: 2px solid #4CAF50; padding-bottom: 10px; }
            .info { background: #e8f4fd; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2196F3; }
            .password-list { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; }
            .password-item { padding: 10px; margin: 5px 0; background: white; border-radius: 5px; font-family: monospace; font-size: 1.1em; border: 1px solid #e0e0e0; }
            .stats { display: flex; gap: 20px; margin: 20px 0; }
            .stat-box { flex: 1; background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
            .stat-number { font-size: 2em; font-weight: bold; color: #4CAF50; }
            .stat-label { color: #666; margin-top: 5px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🔐 ניהול סיסמאות PTT</h1>
            <div class="stats">
                <div class="stat-box">
                    <div class="stat-number">${connectedUsers.size}</div>
                    <div class="stat-label">משתמשים מחוברים</div>
                </div>
                <div class="stat-box">
                    <div class="stat-number">${usersList.length}</div>
                    <div class="stat-label">סיסמאות פעילות</div>
                </div>
            </div>
            <div class="info">
                <strong>הוראות:</strong><br>
                • כל משתמש יכול להיכנס עם כל שם משתמש שירצה<br>
                • הסיסמה חייבת להיות אחת מהסיסמאות המורשות<br>
                • לעדכון סיסמאות - ערוך את הקובץ server.js
            </div>
            <div class="password-list">
                <h3>סיסמאות פעילות:</h3>
                ${usersList.map(pass => `<div class="password-item">${pass}</div>`).join('')}
            </div>
            <div style="text-align: center; margin-top: 30px;">
                <a href="/client.html" style="display:inline-block;padding:15px 30px;background:#4CAF50;color:white;text-decoration:none;border-radius:5px;font-weight:500;">חזור לאפליקציה</a>
            </div>
        </div>
    </body>
    </html>
  `);
});

// ===== עמוד בית (לפי שלך) =====
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>PTT Server</title>
        <meta charset="utf-8">
        <style>
            body { font-family: Arial; text-align: center; padding: 50px; background: #f0f0f0; }
            .container { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: 0 auto; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
            .status { color: green; font-weight: bold; margin: 20px 0; }
            .link { display: inline-block; background: #4CAF50; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 10px; }
            .link:hover { background: #45a049; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📻 PTT Server פועל!</h1>
            <div class="status">✅ השרת פועל בהצלחה</div>
            <p>משתמשים מחוברים: ${connectedUsers.size}</p>
            <p>משדר כעת: ${currentBroadcaster ? 'כן' : 'לא'}</p>
            <h3>🚀 התחל להשתמש:</h3>
            <a href="/client.html" class="link">פתח אפליקציית PTT</a>
            <a href="/admin/users" class="link">ניהול סיסמאות</a>
        </div>
    </body>
    </html>
  `);
});

// ===== Socket.IO (שומר על ה-API שלך + שדרוגי יציבות) =====
io.on('connection', (socket) => {
  console.log(`🔗 משתמש חדש מנסה להתחבר: ${socket.id}`);

  let isAuthenticated = false;
  let authenticatedUser = null;

  // Keep-alive נוסף (בנוסף ל-ping/pong שלך)
  socket.on('client_ping', () => socket.emit('server_pong', Date.now()));

  // === אימות ===
  socket.on('authenticate', (data) => {
    const { name, password } = data || {};
    if (authorizedUsers[password]) {
      isAuthenticated = true;
      authenticatedUser = name || `user-${socket.id.slice(0,5)}`;
      connectedUsers.set(socket.id, { id: socket.id, name: authenticatedUser, joinedAt: new Date() });

      socket.emit('auth_success');
      console.log(`✅ משתמש אומת: ${authenticatedUser}`);
      io.emit('users_count', { count: connectedUsers.size });
    } else {
      socket.emit('auth_failed', { message: 'סיסמה שגויה' });
      console.log(`❌ אימות נכשל עבור: ${name}`);
    }
  });

  // === הצטרפות ===
  socket.on('user_join', (userData) => {
    if (!isAuthenticated) {
      socket.emit('auth_failed', { message: 'נדרש אימות' });
      return;
    }
    console.log(`👤 משתמש הצטרף: ${userData?.name || authenticatedUser || socket.id}`);
    socket.emit('connection_status', {
      connected: true,
      userId: socket.id,
      totalUsers: connectedUsers.size
    });
    io.emit('users_count', { count: connectedUsers.size });
  });

  // === התחלת שידור ===
  socket.on('start_broadcast', () => {
    if (!isAuthenticated) {
      socket.emit('auth_failed', { message: 'נדרש אימות' });
      return;
    }
    if (currentBroadcaster && currentBroadcaster !== socket.id) {
      socket.emit('broadcast_blocked', { message: 'משתמש אחר משדר כרגע' });
      return;
    }
    currentBroadcaster = socket.id;
    const user = connectedUsers.get(socket.id);

    console.log(`🎙️ שידור החל: ${user?.name || socket.id}`);

    // משדרים גם בפורמט הישן שלך:
    socket.broadcast.emit('broadcast_started', {
      broadcasterId: socket.id,
      broadcasterName: user?.name || 'Unknown User',
      startTime: new Date()
    });

    // וגם מזהה פשוט (ללקוחות אחרים אם יש):
    socket.broadcast.emit('broadcast_started_simple', {
      id: socket.id,
      broadcasterName: user?.name || 'Unknown User'
    });

    socket.emit('broadcast_confirmed', { status: 'broadcasting' });
  });

  // === שידור אודיו (תמיכה בשני שמות אירועים) ===
  function forwardAudio(buffer) {
    if (!isAuthenticated) return;
    if (currentBroadcaster !== socket.id) return;
    if (!buffer || (buffer.byteLength !== undefined && buffer.byteLength === 0)) return;

    // משדר החוצה בשתי צורות—תואם לשני צדדים:
    socket.broadcast.emit('receive_audio', {
      audioData: buffer,
      broadcasterId: socket.id,
      timestamp: Date.now(),
      size: buffer.byteLength ?? undefined
    });
    socket.broadcast.emit('audio_chunk', buffer);
  }

  socket.on('audio_stream', forwardAudio); // השם אצלך
  socket.on('audio_chunk', forwardAudio);  // תאימות לקוח אחר

  // === סיום שידור ===
  socket.on('end_broadcast', () => {
    if (!isAuthenticated) return;
    if (currentBroadcaster === socket.id) {
      currentBroadcaster = null;
      const user = connectedUsers.get(socket.id);
      console.log(`🛑 שידור הסתיים: ${user?.name || socket.id}`);

      socket.broadcast.emit('broadcast_ended', {
        broadcasterId: socket.id,
        broadcasterName: user?.name || 'Unknown User',
        endTime: new Date()
      });
      socket.emit('broadcast_stopped', { status: 'stopped' });
    }
  });

  // === Keep alive (שלך) ===
  socket.on('ping', () => socket.emit('pong'));

  // === סטטוס ===
  socket.on('get_status', () => {
    socket.emit('server_status', {
      connected: true,
      totalUsers: connectedUsers.size,
      currentBroadcaster,
      userId: socket.id
    });
  });

  // === ניתוק ===
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    console.log(`❌ משתמש התנתק: ${user?.name || socket.id}`);

    if (currentBroadcaster === socket.id) {
      currentBroadcaster = null;
      socket.broadcast.emit('broadcast_ended', {
        broadcasterId: socket.id,
        broadcasterName: user?.name || 'Unknown User',
        reason: 'disconnected'
      });
    }
    connectedUsers.delete(socket.id);
    io.emit('users_count', { count: connectedUsers.size });
  });

  socket.on('error', (error) => {
    console.error(`שגיאה עבור ${socket.id}:`, error);
  });
});

server.on('error', (error) => {
  console.error('שגיאת שרת:', error);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 שרת PTT פועל על פורט ${PORT}
📡 גישה מקומית: http://localhost:${PORT}
🌐 גישה מהרשת: http://[IP]:${PORT}
🔊 מוכן לקבל חיבורים...
📱 פתח /client.html לאפליקציה
🔐 ניהול סיסמאות: /admin/users
📦 PWA מאופשר - ניתן להתקין כאפליקציה
  `);
});
