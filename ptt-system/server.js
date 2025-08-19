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

// הגש קבצים סטטיים
app.use(express.static(path.join(__dirname)));

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
    "orientation": "portrait-primary",
    "categories": ["communication", "social"],
    "lang": "he",
    "dir": "rtl",
    "icons": [
      {
        "src": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTkyIiBoZWlnaHQ9IjE5MiIgdmlld0JveD0iMCAwIDE5MiAxOTIiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjE5MiIgaGVpZ2h0PSIxOTIiIGZpbGw9IiMzMzMzMzMiIHJ4PSIyNCIvPjwvc3ZnPg==",
        "sizes": "192x192",
        "type": "image/svg+xml"
      }
    ],
    "prefer_related_applications": false,
    "scope": "/",
    "id": "ptt-voice-chat"
  });
});

// Service Worker
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    const CACHE_NAME = 'ptt-chat-v1';
    const urlsToCache = [
      '/client.html',
      '/manifest.json'
    ];

    self.addEventListener('install', (event) => {
      event.waitUntil(
        caches.open(CACHE_NAME)
          .then((cache) => cache.addAll(urlsToCache))
      );
    });

    self.addEventListener('fetch', (event) => {
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

    setInterval(() => {
      console.log('SW: Staying alive...');
    }, 30000);
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
            <p>זמן שרת: ${new Date().toLocaleString()}</p>
            
            <h3>🚀 התחל להשתמש:</h3>
            <a href="/client.html" class="link">פתח אפליקציית PTT</a>
            
            <h3>📱 למובייל:</h3>
            <p>במכשיר נייד, עבור לכתובת:</p>
            <code>${protocol}://${host}/client.html</code>
            
            <h3>📊 סטטיסטיקות:</h3>
            <ul style="text-align: left; display: inline-block;">
                <li>פרוטוקול: ${protocol.toUpperCase()}</li>
                <li>פורט: ${req.socket.localPort}</li>
                <li>Socket.IO פעיל: ✅</li>
                <li>PWA מאופשר: ✅</li>
            </ul>
        </div>
    </body>
    </html>
  `);
});

// Socket.IO
io.on('connection', (socket) => {
  console.log(`🔗 משתמש חדש התחבר: ${socket.id}`);
  
  socket.on('user_join', (userData) => {
    connectedUsers.set(socket.id, {
      id: socket.id,
      name: userData.name || `User_${socket.id.substr(0, 6)}`,
      joinedAt: new Date()
    });
    
    console.log(`👤 משתמש הצטרף: ${userData.name || socket.id}`);
    
    socket.emit('connection_status', {
      connected: true,
      userId: socket.id,
      totalUsers: connectedUsers.size
    });
    
    io.emit('users_count', { count: connectedUsers.size });
  });
  
  socket.on('start_broadcast', (data) => {
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
  
  socket.on('audio_stream', (audioData) => {
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
  
  socket.on('end_broadcast', () => {
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
  
  socket.on('ping', () => {
    socket.emit('pong');
  });
  
  socket.on('get_status', () => {
    socket.emit('server_status', {
      connected: true,
      totalUsers: connectedUsers.size,
      currentBroadcaster: currentBroadcaster,
      userId: socket.id
    });
  });
  
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
📦 PWA מאופשר - ניתן להתקין כאפליקציה
  `);
});