const express = require('express');
const https = require('https');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();

// יצירת תעודת SSL זמנית (לפיתוח בלבד)
const sslOptions = {
  key: generatePrivateKey(),
  cert: generateCertificate()
};

// תעודה זמנית לפיתוח
function generatePrivateKey() {
  return `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKB
wQNneCjN6fEiOpjWZoRSEF1BTnVU3w8QGKRR4nxhFkSzJhOt82URHPcHRdgR8xFP
kkUOF7H8i7q+QgQ6H4q9v+zFkM5J7MhK5zKhM3vdN+z3Nj9YbhKy8zO2yz5L3B
-----END PRIVATE KEY-----`;
}

function generateCertificate() {
  return `-----BEGIN CERTIFICATE-----
MIIDXTCCAkWgAwIBAgIJAJ3z5Y4xJ5qzMA0GCSqGSIb3DQEBCwUAMEUxCzAJBgNV
BAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5ldCBX
aWRnaXRzIFB0eSBMdGQwHhcNMjMwMTE4MTkzODQ4WhcNMjQwMTE4MTkzODQ4WjBF
-----END CERTIFICATE-----`;
}

// השתמש ב-HTTP פשוט אם אין SSL
let server;
try {
  server = https.createServer(sslOptions, app);
  console.log('🔒 HTTPS Server enabled');
} catch (error) {
  server = http.createServer(app);
  console.log('⚠️ HTTP Server (no SSL)');
}

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// הגש קבצים סטטיים (כולל HTML)
app.use(express.static(path.join(__dirname)));

let connectedUsers = new Map();
let currentBroadcaster = null;

// דף בדיקה עם לינק לאפליקציה
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
            .warning { background: #ff9800; color: white; padding: 15px; border-radius: 5px; margin: 20px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📻 PTT Server פועל!</h1>
            <div class="status">✅ השרת פועל בהצלחה</div>
            <p>משתמשים מחוברים: ${connectedUsers.size}</p>
            <p>משדר כעת: ${currentBroadcaster ? 'כן' : 'לא'}</p>
            <p>זמן שרת: ${new Date().toLocaleString()}</p>
            
            ${!req.secure ? `
            <div class="warning">
                ⚠️ השרת רץ ב-HTTP - מיקרופון עלול לא לעבוד במובייל
                <br>למובייל: השתמש ב-chrome://flags או פתח אתר ב-HTTPS
            </div>
            ` : ''}
            
            <h3>🚀 התחל להשתמש:</h3>
            <a href="/client.html" class="link">פתח אפליקציית PTT</a>
            
            <h3>📱 למובייל:</h3>
            <p>במכשיר נייד, עבור לכתובת:</p>
            <code>${protocol}://${host}/client.html</code>
            
            <h3>🔧 אם מיקרופון לא עובד במובייל:</h3>
            <ol style="text-align: left; display: inline-block;">
                <li>Chrome: chrome://flags/#unsafely-treat-insecure-origin-as-secure</li>
                <li>הוסף: ${protocol}://${host}</li>
                <li>הפעל ואתחל דפדפן</li>
            </ol>
            
            <h3>📊 סטטיסטיקות:</h3>
            <ul style="text-align: left; display: inline-block;">
                <li>פרוטוקול: ${protocol.toUpperCase()}</li>
                <li>פורט: ${req.socket.localPort}</li>
                <li>Socket.IO פעיל: ✅</li>
                <li>CORS מאופשר: ✅</li>
            </ul>
        </div>
    </body>
    </html>
  `);
});

// שאר הקוד נשאר זהה...
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
  const protocol = server instanceof https.Server ? 'https' : 'http';
  console.log(`
🚀 שרת PTT פועל על פורט ${PORT}
📡 גישה מקומית: ${protocol}://localhost:${PORT}
🌐 גישה מהרשת: ${protocol}://[IP]:${PORT}
🔊 מוכן לקבל חיבורים...
📱 פתח /client.html לאפליקציה
${protocol === 'http' ? '⚠️ למיקרופון במובייל: דרוש HTTPS או chrome://flags' : '🔒 HTTPS מופעל'}
  `);
});