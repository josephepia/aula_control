const express = require('express');
const http = require('http');
const path = require('path');
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

// Servir la interfaz pública
app.use(express.static(path.join(__dirname, 'public')));

// Estado persistente en memoria: key = socket.id -> { id, hostname, ip, handRaised, handRaisedAt, isScreenSharing, blockedDNS, lastScreenFrame, connectedAt }
const studentsMap = new Map();

function broadcastStudentsList() {
  const list = Array.from(studentsMap.values());
  io.emit('students-list', list);
}

function registerOrUpdateStudent(socket, data = {}) {
  const clientIp = socket.handshake.address.replace(/^.*:/, '') || '127.0.0.1';
  const existing = studentsMap.get(socket.id) || {};

  const studentInfo = {
    id: socket.id,
    hostname: data.hostname || data.name || existing.hostname || `Estudiante-${socket.id.slice(0, 4)}`,
    ip: data.ip || clientIp,
    handRaised: typeof data.handRaised === 'boolean' ? data.handRaised : (existing.handRaised || false),
    handRaisedAt: data.handRaisedAt || existing.handRaisedAt || null,
    isScreenSharing: typeof data.isScreenSharing === 'boolean' ? data.isScreenSharing : (existing.isScreenSharing || false),
    blockedDNS: typeof data.blockedDNS === 'boolean' ? data.blockedDNS : (existing.blockedDNS || false),
    lastScreenFrame: existing.lastScreenFrame || null,
    connectedAt: existing.connectedAt || new Date().toISOString()
  };

  studentsMap.set(socket.id, studentInfo);
  console.log(`[Estudiante Registrado] ${studentInfo.hostname} (${studentInfo.ip})`);
  broadcastStudentsList();
}

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address.replace(/^.*:/, '') || '127.0.0.1';
  console.log(`[+] Conexión establecida: ${socket.id} (IP: ${clientIp})`);

  // Estado inicial para nuevos clientes / reconexiones
  socket.emit('students-list', Array.from(studentsMap.values()));
  io.emit('sync-request');

  // Registro de estudiante
  socket.on('register-student', (data) => registerOrUpdateStudent(socket, data));
  socket.on('student-join', (data) => registerOrUpdateStudent(socket, data));

  socket.on('maestro-joined', () => {
    console.log('[Server] Maestro unido/conectado. Solicitando sync-request a estudiantes...');
    socket.emit('students-list', Array.from(studentsMap.values()));
    io.emit('sync-request');
  });

  // --- 1. SEÑALIZACIÓN WEBRTC (PEER-TO-PEER VIDEO) ---
  socket.on('webrtc-offer', (payload) => {
    // payload: { targetSocketId, offer }
    if (payload && payload.targetSocketId) {
      console.log(`[WebRTC] Relay OFFER desde ${socket.id} hacia ${payload.targetSocketId}`);
      io.to(payload.targetSocketId).emit('webrtc-offer', {
        senderSocketId: socket.id,
        offer: payload.offer
      });
    }
  });

  socket.on('webrtc-answer', (payload) => {
    // payload: { targetSocketId, answer }
    if (payload && payload.targetSocketId) {
      console.log(`[WebRTC] Relay ANSWER desde ${socket.id} hacia ${payload.targetSocketId}`);
      io.to(payload.targetSocketId).emit('webrtc-answer', {
        senderSocketId: socket.id,
        answer: payload.answer
      });
    }
  });

  socket.on('webrtc-candidate', (payload) => {
    // payload: { targetSocketId, candidate }
    if (payload && payload.targetSocketId) {
      io.to(payload.targetSocketId).emit('webrtc-candidate', {
        senderSocketId: socket.id,
        candidate: payload.candidate
      });
    }
  });

  // --- 2. GESTOR DE ARCHIVOS REMOTO (FS SYNC) ---
  socket.on('fs-read-directory', (payload) => {
    // payload: { targetSocketId, dirPath }
    if (payload && payload.targetSocketId && studentsMap.has(payload.targetSocketId)) {
      console.log(`[FS] Solicitando directorio en ${payload.targetSocketId}: ${payload.dirPath}`);
      io.to(payload.targetSocketId).emit('fs-read-directory', {
        requesterSocketId: socket.id,
        dirPath: payload.dirPath
      });
    }
  });

  socket.on('fs-directory-result', (payload) => {
    // payload: { requesterSocketId, currentPath, items, error }
    if (payload && payload.requesterSocketId) {
      io.to(payload.requesterSocketId).emit('fs-directory-result', payload);
    }
  });

  socket.on('fs-create-directory', (payload) => {
    // payload: { targetSocketId, parentPath, folderName }
    if (payload && payload.targetSocketId && studentsMap.has(payload.targetSocketId)) {
      io.to(payload.targetSocketId).emit('fs-create-directory', {
        requesterSocketId: socket.id,
        parentPath: payload.parentPath,
        folderName: payload.folderName
      });
    }
  });

  socket.on('fs-upload-file', (payload) => {
    // payload: { targetSocketId, targetPath, fileName, fileBase64 }
    if (payload && payload.targetSocketId && studentsMap.has(payload.targetSocketId)) {
      console.log(`[FS] Enviando archivo ${payload.fileName} a ${payload.targetSocketId}`);
      io.to(payload.targetSocketId).emit('fs-upload-file', {
        requesterSocketId: socket.id,
        targetPath: payload.targetPath,
        fileName: payload.fileName,
        fileBase64: payload.fileBase64
      });
    }
  });

  socket.on('fs-operation-result', (payload) => {
    // payload: { requesterSocketId, success, message }
    if (payload && payload.requesterSocketId) {
      io.to(payload.requesterSocketId).emit('fs-operation-result', payload);
    }
  });

  // --- MANOS LEVANTADAS Y CHAT ---
  socket.on('toggle-hand', () => {
    const student = studentsMap.get(socket.id);
    if (student) {
      student.handRaised = !student.handRaised;
      student.handRaisedAt = student.handRaised ? new Date().toLocaleTimeString() : null;
      console.log(`[Mano] ${student.hostname}: ${student.handRaised ? 'Levantada' : 'Bajada'}`);
      broadcastStudentsList();
    }
  });

  socket.on('maestro-lower-hand', (targetSocketId = null) => {
    if (targetSocketId && studentsMap.has(targetSocketId)) {
      const s = studentsMap.get(targetSocketId);
      if (s) { s.handRaised = false; s.handRaisedAt = null; }
    } else {
      for (const s of studentsMap.values()) {
        s.handRaised = false;
        s.handRaisedAt = null;
      }
    }
    broadcastStudentsList();
  });

  socket.on('chat-message', (data) => {
    const student = studentsMap.get(socket.id);
    const messagePayload = {
      sender: student ? student.hostname : (data.sender || 'Maestro'),
      role: student ? 'student' : (data.role || 'maestro'),
      message: data.message,
      timestamp: new Date().toLocaleTimeString()
    };
    io.emit('chat-message', messagePayload);
  });

  // --- DNS LIST MANAGER ---
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
      if (targetSocketId && studentsMap.has(targetSocketId)) {
        io.to(targetSocketId).emit('unblock-dns');
        const s = studentsMap.get(targetSocketId);
        if (s) s.blockedDNS = false;
      } else {
        io.emit('unblock-dns');
        for (const s of studentsMap.values()) s.blockedDNS = false;
      }
    } else {
      if (targetSocketId && studentsMap.has(targetSocketId)) {
        io.to(targetSocketId).emit('block-dns', { domains: uniqueDomains });
        const s = studentsMap.get(targetSocketId);
        if (s) s.blockedDNS = true;
      } else {
        io.emit('block-dns', { domains: uniqueDomains });
        for (const s of studentsMap.values()) s.blockedDNS = true;
      }
    }
    broadcastStudentsList();
  });

  // Recepción de fotogramas de pantalla (Miniaturas Grilla)
  socket.on('screen-frame', (frameData) => {
    const student = studentsMap.get(socket.id);
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

  // Desconexión
  socket.on('disconnect', () => {
    if (studentsMap.has(socket.id)) {
      const student = studentsMap.get(socket.id);
      console.log(`[-] Estudiante desconectado: ${student.hostname}`);
      studentsMap.delete(socket.id);
      broadcastStudentsList();
    }
  });
});

function startEmbeddedServer(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`=================================`);
      console.log(` Servidor Maestro Aula Control escuchando en:`);
      console.log(` http://localhost:${port}`);
      console.log(`=================================`);
      resolve(server);
    });
  });
}

// Permitir require() como módulo desde la app unificada
module.exports = { app, server, io, startEmbeddedServer };

if (require.main === module) {
  startEmbeddedServer(PORT);
}
