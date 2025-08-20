const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// רשימת משתמשים מורשים - ערוך כאן!
const authorizedUsers = {
    'password123': true,     // סיסמה כללית לכולם
    'admin': true,           // סיסמת אדמין
    'user2024': true,        // סיסמה נוספת
    // הוסף עוד סיסמאות כרצונך
};

let connectedUsers = new Map();
let currentBroadcaster = null;

// PWA Manifest
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

// Service Worker
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    const CACHE_NAME = 'ptt-chat-v2';
    const urlsToCache = [
      '/client.html',
      '/manifest.json',
      '/assets/beep.mp3'
    ];

    self.addEventListener('install', (event) => {
      event.waitUntil(
        caches.open(CACHE_NAME)
          .then((cache) => cache.addAll(urlsToCache))
      );
      self.skipWaiting();
    });

    self.addEventListener('activate', (event) => {
      event.waitUntil(clients.claim());
    });

    self.addEventListener('fetch', (event) => {
      if (event.request.url.includes('/socket.io/')) {
        return;
      }
      
      event.respondWith(
        caches.match(event.request)
          .then((response) => response || fetch(event.request))
      );
    });

    self.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'KEEP_ALIVE') {
        console.log('SW: Keep alive signal received');
      }
    });
  `);
});

// עמוד ניהול משתמשים
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
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
                padding: 30px; 
                background: #f0f0f0; 
                margin: 0;
            }
            .container { 
                background: white; 
                padding: 30px; 
                border-radius: 10px; 
                max-width: 600px; 
                margin: 0 auto;
                box-shadow: 0 4px 8px rgba(0,0,0,0.1);
            }
            h1 { 
                color: #333; 
                border-bottom: 2px solid #4CAF50;
                padding-bottom: 10px;
            }
            .info {
                background: #e8f4fd;
                padding: 15px;
                border-radius: 8px;
                margin: 20px 0;
                border-left: 4px solid #2196F3;
            }
            .password-list {
                background: #f8f9fa;
                padding: 20px;
                border-radius: 8px;
                margin: 20px 0;
            }
            .password-item {
                padding: 10px;
                margin: 5px 0;
                background: white;
                border-radius: 5px;
                font-family: monospace;
                font-size: 1.1em;
                border: 1px solid #e0e0e0;
            }
            .stats {
                display: flex;
                gap: 20px;
                margin: 20px 0;
            }
            .stat-box {
                flex: 1;
                background: #f8f9fa;
                padding: 15px;
                border-radius: 8px;
                text-align: center;
            }
            .stat-number {
                font-size: 2em;
                font-weight: bold;
                color: #4CAF50;
            }
            .stat-label {
                color: #666;
                margin-top: 5px;
            }
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
                <a href="/client.html" style="
                    display: inline-block;
                    padding: 15px 30px;
                    background: #4CAF50;
                    color: white;
                    text-decoration: none;
                    border-radius: 5px;
                    font-weight: 500;
                ">חזור לאפליקציה</a>
            </div>
        </div>
    </body>
    </html>
  `);
});

// עמוד בית
app.get('/', (req, res) => {
  const protocol = req.secure ? 'https' : 'http';
  const host = req.get('host');
  
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

// Socket.IO עם אימות
io.on('connection', (socket) => {
  console.log(`🔗 משתמש חדש מנסה להתחבר: ${socket.id}`);
  
  let isAuthenticated = false;
  let authenticatedUser = null;
  
  // אימות משתמש
  socket.on('authenticate', (data) => {
    const { name, password } = data;
    
    if (authorizedUsers[password]) {
      isAuthenticated = true;
      authenticatedUser = name;
      
      connectedUsers.set(socket.id, {
        id: socket.id,
        name: name,
        joinedAt: new Date()
      });
      
      socket.emit('auth_success');
      console.log(`✅ משתמש אומת בהצלחה: ${name}`);
    } else {
      socket.emit('auth_failed', { message: 'סיסמה שגויה' });
      console.log(`❌ אימות נכשל עבור: ${name}`);
    }
  });
  
  // הצטרפות משתמש
  socket.on('user_join', (userData) => {
    if (!isAuthenticated) {
      socket.emit('auth_failed', { message: 'נדרש אימות' });
      return;
    }
    
    console.log(`👤 משתמש הצטרף: ${userData.name || socket.id}`);
    
    socket.emit('connection_status', {
      connected: true,
      userId: socket.id,
      totalUsers: connectedUsers.size
    });
    
    io.emit('users_count', { count: connectedUsers.size });
  });
  
  // התחלת שידור
  socket.on('start_broadcast', (data) => {
    if (!isAuthenticated) {
      socket.emit('auth_failed', { message: 'נדרש אימות' });
      return;
    }
    
    if (currentBroadcaster && currentBroadcaster !== socket.id) {
      socket.emit('broadcast_blocked', { 
        message: 'משתמש אחר משדר כרגע' 
      });
      return;
    }
    
    currentBroadcaster = socket.id;
    const user = connectedUsers.get(socket.id);
    
    console.log(`🎙️ שידור החל: ${user?.name || socket.id}`);
    
    socket.broadcast.emit('broadcast_started', {
      broadcasterId: socket.id,
      broadcasterName: user?.name || 'Unknown User',
      startTime: new Date()
    });
    
    socket.emit('broadcast_confirmed', { status: 'broadcasting' });
  });
  
  // שידור אודיו
  socket.on('audio_stream', (audioData) => {
    if (!isAuthenticated) return;
    
    if (currentBroadcaster !== socket.id) {
      return;
    }
    
    if (!audioData || audioData.byteLength === 0) {
      console.log('⚠️ נתוני אודיו ריקים');
      return;
    }
    
    socket.broadcast.emit('receive_audio', {
      audioData: audioData,
      broadcasterId: socket.id,
      timestamp: Date.now(),
      size: audioData.byteLength
    });
    
    if (audioData.byteLength > 1000) {
      console.log(`📡 שידור אודיו: ${audioData.byteLength} bytes`);
    }
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
        broadcasterName: user?.name || 'Unknown User',
        endTime: new Date()
      });
      
      socket.emit('broadcast_stopped', { status: 'stopped' });
    }
  });
  
  // Keep alive
  socket.on('ping', () => {
    socket.emit('pong');
  });
  
  // סטטוס
  socket.on('get_status', () => {
    socket.emit('server_status', {
      connected: true,
      totalUsers: connectedUsers.size,
      currentBroadcaster: currentBroadcaster,
      userId: socket.id
    });
  });
  
  // ניתוק
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