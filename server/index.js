const express = require('express');
const http = require('http');
const path = require('path');
const dgram = require('dgram');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let maestroInstanceId = null;
let maestroUdpSocket = null;
let maestroUdpInterval = null;

function getLocalIPv4Address() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

app.get('/api/identity', (req, res) => {
  res.json({
    service: 'AULA_CONTROL_MASTER',
    port: PORT,
    name: os.hostname(),
    instanceId: maestroInstanceId,
    hostIp: getLocalIPv4Address()
  });
});

// 1. REGISTRO GLOBAL DE ESTUDIANTES CONECTADOS (connectedStudents Map)
const connectedStudents = new Map();
const unlinkedRadarDevices = new Map();

function broadcastStudentsList() {
  const list = Array.from(connectedStudents.values());
  io.emit('update-student-list', list);
  io.emit('students-list', list);
}

function broadcastUnlinkedRadarDevices() {
  const unlinkedList = Array.from(unlinkedRadarDevices.values());
  io.emit('update-radar-unlinked', unlinkedList);
}

function registerOrUpdateStudent(socket, data = {}) {
  const role = data.role || 'student';
  
  // Si role === 'teacher', NO guardarlo en connectedStudents
  if (role === 'teacher') {
    console.log(`[Socket ${socket.id}] Conectado como Rol 'teacher'. No se guarda en connectedStudents.`);
    return;
  }

  let rawIp = socket.handshake.address || '';
  let clientIp = rawIp.replace(/^.*:/, '').replace(/^::ffff:/, '').trim();

  if ((!clientIp || clientIp === '127.0.0.1' || clientIp === 'localhost') && data.ip && data.ip !== 'Cliente') {
    clientIp = data.ip;
  }

  const existing = connectedStudents.get(socket.id) || {};

  const studentData = {
    socketId: socket.id,
    id: socket.id,
    hostname: data.hostname || data.name || existing.hostname || `Estudiante-${socket.id.slice(0, 4)}`,
    ip: clientIp || '127.0.0.1',
    role: 'student',
    status: 'online',
    handRaised: typeof data.handRaised === 'boolean' ? data.handRaised : (existing.handRaised || false),
    handRaisedAt: data.handRaisedAt || existing.handRaisedAt || null,
    isScreenSharing: typeof data.isScreenSharing === 'boolean' ? data.isScreenSharing : (existing.isScreenSharing || false),
    blockedDNS: typeof data.blockedDNS === 'boolean' ? data.blockedDNS : (existing.blockedDNS || false),
    lastScreenFrame: existing.lastScreenFrame || null,
    connectedAt: existing.connectedAt || new Date().toISOString()
  };

  // Guardar en el Map global
  connectedStudents.set(socket.id, studentData);

  for (const [key, dev] of unlinkedRadarDevices.entries()) {
    if (dev.ip === clientIp || dev.hostname === studentData.hostname) {
      unlinkedRadarDevices.delete(key);
    }
  }

  console.log(`[Estudiante Registrado] ${studentData.hostname} (IP: ${studentData.ip}) - Socket ID: ${socket.id}`);
  
  // Broadcast a la UI del Maestro con el listado actualizado
  broadcastStudentsList();
  broadcastUnlinkedRadarDevices();
}

io.on('connection', (socket) => {
  const rawIp = socket.handshake.address || '';
  const clientIp = rawIp.replace(/^.*:/, '').replace(/^::ffff:/, '').trim() || '127.0.0.1';
  console.log(`[+] Conexión socket recibida: ${socket.id} (IP: ${clientIp})`);

  // Enviar lista actual al conectar
  const currentList = Array.from(connectedStudents.values());
  socket.emit('update-student-list', currentList);
  socket.emit('students-list', currentList);
  socket.emit('update-radar-unlinked', Array.from(unlinkedRadarDevices.values()));

  // Manejo de eventos de registro
  socket.on('register-student', (data) => registerOrUpdateStudent(socket, data));
  socket.on('student-join', (data) => registerOrUpdateStudent(socket, data));

  // Manejo de sincronización manual de la lista
  socket.on('request-student-list', () => {
    console.log(`[Sync Request] Solicitud manual 'request-student-list' recibida de ${socket.id}`);
    const list = Array.from(connectedStudents.values());
    socket.emit('update-student-list', list);
    socket.emit('students-list', list);
  });

  socket.on('maestro-joined', () => {
    console.log('[Server] Maestro unido a la sesión.');
    const list = Array.from(connectedStudents.values());
    socket.emit('update-student-list', list);
    socket.emit('students-list', list);
    socket.emit('update-radar-unlinked', Array.from(unlinkedRadarDevices.values()));
  });

  // WebRTC Signals
  socket.on('webrtc-offer', (payload) => {
    if (payload && payload.targetSocketId) {
      io.to(payload.targetSocketId).emit('webrtc-offer', {
        senderSocketId: socket.id,
        offer: payload.offer
      });
    }
  });

  socket.on('webrtc-answer', (payload) => {
    if (payload && payload.targetSocketId) {
      io.to(payload.targetSocketId).emit('webrtc-answer', {
        senderSocketId: socket.id,
        answer: payload.answer
      });
    }
  });

  socket.on('webrtc-candidate', (payload) => {
    if (payload && payload.targetSocketId) {
      io.to(payload.targetSocketId).emit('webrtc-candidate', {
        senderSocketId: socket.id,
        candidate: payload.candidate
      });
    }
  });

  // FS Engine
  socket.on('fs-read-directory', (payload) => {
    if (payload && payload.targetSocketId && connectedStudents.has(payload.targetSocketId)) {
      io.to(payload.targetSocketId).emit('fs-read-directory', {
        requesterSocketId: socket.id,
        dirPath: payload.dirPath
      });
    }
  });

  socket.on('fs-directory-result', (payload) => {
    if (payload && payload.requesterSocketId) {
      io.to(payload.requesterSocketId).emit('fs-directory-result', payload);
    }
  });

  socket.on('fs-create-directory', (payload) => {
    if (payload && payload.targetSocketId && connectedStudents.has(payload.targetSocketId)) {
      io.to(payload.targetSocketId).emit('fs-create-directory', {
        requesterSocketId: socket.id,
        parentPath: payload.parentPath,
        folderName: payload.folderName
      });
    }
  });

  socket.on('fs-upload-file', (payload) => {
    if (payload && payload.targetSocketId && connectedStudents.has(payload.targetSocketId)) {
      io.to(payload.targetSocketId).emit('fs-upload-file', {
        requesterSocketId: socket.id,
        targetPath: payload.targetPath,
        fileName: payload.fileName,
        fileBase64: payload.fileBase64
      });
    }
  });

  socket.on('fs-operation-result', (payload) => {
    if (payload && payload.requesterSocketId) {
      io.to(payload.requesterSocketId).emit('fs-operation-result', payload);
    }
  });

  // Hands & Chat
  socket.on('toggle-hand', () => {
    const student = connectedStudents.get(socket.id);
    if (student) {
      student.handRaised = !student.handRaised;
      student.handRaisedAt = student.handRaised ? new Date().toLocaleTimeString() : null;
      broadcastStudentsList();
    }
  });

  socket.on('maestro-lower-hand', (targetSocketId = null) => {
    if (targetSocketId && connectedStudents.has(targetSocketId)) {
      const s = connectedStudents.get(targetSocketId);
      if (s) { s.handRaised = false; s.handRaisedAt = null; }
    } else {
      for (const s of connectedStudents.values()) {
        s.handRaised = false;
        s.handRaisedAt = null;
      }
    }
    broadcastStudentsList();
  });

  socket.on('chat-message', (data) => {
    const student = connectedStudents.get(socket.id);
    const messagePayload = {
      sender: student ? student.hostname : (data.sender || 'Maestro'),
      role: student ? 'student' : (data.role || 'maestro'),
      message: data.message,
      timestamp: new Date().toLocaleTimeString()
    };
    io.emit('chat-message', messagePayload);
  });

  // DNS
  socket.on('update-dns-list', (payload = {}) => {
    let targetSocketId = null;
    let domains = [];

    if (payload && typeof payload === 'object') {
      if (payload.targetSocketId) targetSocketId = payload.targetSocketId;
      if (Array.isArray(payload.domains)) {
        domains = payload.domains;
      } else if (typeof payload.domains === 'string') {
        domains = payload.domains.split(/[\s,\n\r]+/).map(d => d.trim()).filter(Boolean);
      }
    } else if (Array.isArray(payload)) {
      domains = payload;
    }

    const fullDomains = [];
    domains.forEach(d => {
      const clean = d.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
      if (clean) {
        fullDomains.push(clean);
        if (!clean.startsWith('www.')) fullDomains.push(`www.${clean}`);
      }
    });
    const uniqueDomains = Array.from(new Set(fullDomains));

    if (uniqueDomains.length === 0) {
      if (targetSocketId && connectedStudents.has(targetSocketId)) {
        io.to(targetSocketId).emit('unblock-dns');
        const s = connectedStudents.get(targetSocketId);
        if (s) s.blockedDNS = false;
      } else {
        io.emit('unblock-dns');
        for (const s of connectedStudents.values()) s.blockedDNS = false;
      }
    } else {
      if (targetSocketId && connectedStudents.has(targetSocketId)) {
        io.to(targetSocketId).emit('block-dns', { domains: uniqueDomains });
        const s = connectedStudents.get(targetSocketId);
        if (s) s.blockedDNS = true;
      } else {
        io.emit('block-dns', { domains: uniqueDomains });
        for (const s of connectedStudents.values()) s.blockedDNS = true;
      }
    }
    broadcastStudentsList();
  });

  socket.on('screen-frame', (frameData) => {
    const student = connectedStudents.get(socket.id);
    if (student) {
      student.isScreenSharing = true;
      student.lastScreenFrame = frameData;
    }
    io.emit('screen-stream', {
      studentId: socket.id,
      studentName: student ? student.hostname : 'Estudiante',
      frame: frameData
    });
  });

  // Manejo del evento disconnect
  socket.on('disconnect', () => {
    if (connectedStudents.has(socket.id)) {
      const student = connectedStudents.get(socket.id);
      console.log(`[-] Estudiante desconectado: ${student.hostname}`);
      
      // Eliminar del Map
      connectedStudents.delete(socket.id);

      // Emitir nuevamente el listado actualizado
      broadcastStudentsList();
    }
  });
});

// Emisión Radar UDP del Maestro
function startMaestroUdpBroadcast(port = 3000, instanceId = null) {
  if (instanceId) maestroInstanceId = instanceId;

  try {
    if (maestroUdpSocket) {
      try { maestroUdpSocket.close(); } catch(e){}
    }

    maestroUdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    maestroUdpSocket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data && data.type === 'AULA_RADAR_ANNOUNCE') {
          const devIp = rinfo.address;
          let isConnected = false;
          for (const s of connectedStudents.values()) {
            if (s.ip === devIp || s.hostname === data.hostname) {
              isConnected = true;
              break;
            }
          }

          if (!isConnected) {
            unlinkedRadarDevices.set(devIp, {
              ip: devIp,
              hostname: data.hostname || 'Equipo Estudiante LAN',
              lastSeen: new Date().toLocaleTimeString()
            });
            broadcastUnlinkedRadarDevices();
          }
        }
      } catch (e) {}
    });

    maestroUdpSocket.bind(41234, () => {
      maestroUdpSocket.setBroadcast(true);
      console.log('[Radar Maestro UDP] Emisión AULA_CONTROL_MASTER activada en puerto 41234 con InstanceId:', maestroInstanceId);
    });

    if (maestroUdpInterval) clearInterval(maestroUdpInterval);

    maestroUdpInterval = setInterval(() => {
      if (!maestroUdpSocket) return;
      const payload = JSON.stringify({
        service: 'AULA_CONTROL_MASTER',
        port: port,
        instanceId: maestroInstanceId,
        hostIp: getLocalIPv4Address(),
        name: os.hostname(),
        timestamp: Date.now()
      });
      const msg = Buffer.from(payload);
      maestroUdpSocket.send(msg, 0, msg.length, 41234, '255.255.255.255', (err) => {});
    }, 3000);
  } catch (err) {
    console.warn('[Radar Maestro UDP Error]:', err.message);
  }
}

function stopMaestroUdpBroadcast() {
  if (maestroUdpInterval) {
    clearInterval(maestroUdpInterval);
    maestroUdpInterval = null;
  }
  if (maestroUdpSocket) {
    try { maestroUdpSocket.close(); } catch(e){}
    maestroUdpSocket = null;
  }
}

function startEmbeddedServer(port = PORT, instanceId = null) {
  if (instanceId) maestroInstanceId = instanceId;
  return new Promise((resolve) => {
    if (server.listening) {
      startMaestroUdpBroadcast(port, instanceId);
      return resolve(server);
    }
    server.listen(port, () => {
      console.log(`=================================`);
      console.log(` Servidor Maestro Aula Control escuchando en:`);
      console.log(` http://localhost:${port}`);
      console.log(`=================================`);
      startMaestroUdpBroadcast(port, instanceId);
      resolve(server);
    });
  });
}

function stopEmbeddedServer() {
  stopMaestroUdpBroadcast();
  connectedStudents.clear();
  unlinkedRadarDevices.clear();

  if (server && server.listening) {
    try {
      server.close(() => {
        console.log('[Server] Servidor HTTP y Socket.io local detenido.');
      });
    } catch (e) {}
  }
  console.log('[Server Maestro] Limpieza total de sesión completada.');
}

module.exports = { app, server, io, startEmbeddedServer, stopEmbeddedServer };

if (require.main === module) {
  startEmbeddedServer(PORT);
}
