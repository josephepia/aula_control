const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const { exec } = require('child_process');
const io = require('socket.io-client');

let mainWindow = null;
let socket = null;
let screenInterval = null;
let currentStudentName = '';
let isCapturing = false;

// Mapa de pares descubiertos por Radar UDP
const discoveredRadarPeers = new Map();

// Servidor local embebido si se activa modo Maestro
let embeddedServerStarted = false;

// --- 1. RADAR AUTO-DESCUBRIMIENTO UDP (dgram) ---
const RADAR_PORT = 41234;
let udpSocket = null;

function setupRadarDiscovery() {
  try {
    udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    udpSocket.on('error', (err) => {
      console.warn('[Radar UDP Warning]:', err.message);
    });

    udpSocket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data && data.type === 'AULA_RADAR_ANNOUNCE') {
          const peerId = `${rinfo.address}:${data.port || 3000}`;
          discoveredRadarPeers.set(peerId, {
            ip: rinfo.address,
            hostname: data.hostname || 'Equipo LAN',
            port: data.port || 3000,
            lastSeen: Date.now()
          });

          if (mainWindow) {
            mainWindow.webContents.send('radar-discovered-peers', Array.from(discoveredRadarPeers.values()));
          }
        }
      } catch (e) {
        // Ignorar mensajes no JSON
      }
    });

    udpSocket.bind(RADAR_PORT, () => {
      udpSocket.setBroadcast(true);
      console.log(`[Radar LAN] Escuchando y anunciando en puerto UDP ${RADAR_PORT}`);
    });

    // Anuncio recurrente cada 3 segundos en broadcast
    setInterval(() => {
      if (!udpSocket) return;
      const announcement = JSON.stringify({
        type: 'AULA_RADAR_ANNOUNCE',
        hostname: currentStudentName || os.hostname() || 'Estudiante-PC',
        port: 3000,
        timestamp: Date.now()
      });

      const message = Buffer.from(announcement);
      udpSocket.send(message, 0, message.length, RADAR_PORT, '255.255.255.255', (err) => {
        if (err && err.code !== 'EADDRNOTAVAIL') {
          // Ignorar errores menores de interfaz de red
        }
      });
    }, 3000);

  } catch (err) {
    console.warn('[Radar Error]:', err.message);
  }
}

// --- 2. FILE SYSTEM REMOTO (fs + path) ---
function getHostsPath() {
  if (process.platform === 'win32') {
    return 'C:\\Windows\\System32\\drivers\\etc\\hosts';
  }
  return '/etc/hosts';
}

function blockDNS(domains = []) {
  const hostsPath = getHostsPath();
  const startMarker = '# AULA_CONTROL_BLOCK_START';
  const endMarker = '# AULA_CONTROL_BLOCK_END';

  try {
    let content = fs.existsSync(hostsPath) ? fs.readFileSync(hostsPath, 'utf8') : '';

    const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\n?`, 'g');
    content = content.replace(regex, '').trim();

    if (domains.length === 0) {
      domains = ['facebook.com', 'www.facebook.com', 'youtube.com', 'www.youtube.com', 'instagram.com', 'www.instagram.com', 'tiktok.com', 'www.tiktok.com'];
    }

    const entries = domains.map(domain => `127.0.0.1 ${domain}`).join('\n');
    const blockText = `\n\n${startMarker}\n${entries}\n${endMarker}\n`;

    const newContent = content + blockText;

    try {
      fs.writeFileSync(hostsPath, newContent, 'utf8');
      console.log(`[DNS] Archivo hosts (${hostsPath}) modificado con éxito. Dominios bloqueados:`, domains.length);
      return { success: true };
    } catch (writeErr) {
      const tempFile = path.join(os.tmpdir(), 'hosts_aula_control');
      fs.writeFileSync(tempFile, newContent, 'utf8');

      if (process.platform === 'win32') {
        const cmd = `powershell -Command "Start-Process cmd -ArgumentList '/c copy /y \"${tempFile}\" \"${hostsPath}\"' -Verb RunAs"`;
        exec(cmd);
      } else {
        exec(`sudo cp "${tempFile}" "${hostsPath}"`);
      }
      return { success: true, elevated: true };
    }
  } catch (err) {
    console.error('[DNS Error]:', err);
    return { success: false, error: err.message };
  }
}

function unblockDNS() {
  const hostsPath = getHostsPath();
  const startMarker = '# AULA_CONTROL_BLOCK_START';
  const endMarker = '# AULA_CONTROL_BLOCK_END';

  try {
    if (!fs.existsSync(hostsPath)) return { success: true };

    let content = fs.readFileSync(hostsPath, 'utf8');
    const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\n?`, 'g');
    const newContent = content.replace(regex, '').trim();

    try {
      fs.writeFileSync(hostsPath, newContent, 'utf8');
      console.log(`[DNS] Dominios desbloqueados en ${hostsPath}`);
      return { success: true };
    } catch (writeErr) {
      const tempFile = path.join(os.tmpdir(), 'hosts_aula_control');
      fs.writeFileSync(tempFile, newContent, 'utf8');

      if (process.platform === 'win32') {
        const cmd = `powershell -Command "Start-Process cmd -ArgumentList '/c copy /y \"${tempFile}\" \"${hostsPath}\"' -Verb RunAs"`;
        exec(cmd);
      } else {
        exec(`sudo cp "${tempFile}" "${hostsPath}"`);
      }
      return { success: true };
    }
  } catch (err) {
    console.error('[DNS Error]:', err);
    return { success: false, error: err.message };
  }
}

// Miniaturas de pantalla para Grilla
async function captureAndSendScreen() {
  if (isCapturing) return;
  isCapturing = true;

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 }
    });

    if (sources.length > 0 && socket && socket.connected) {
      const primarySource = sources[0];
      const base64Frame = primarySource.thumbnail.toDataURL();
      socket.emit('screen-frame', base64Frame);
    }
  } catch (err) {
    console.error('[Screen Capture Error]:', err);
  } finally {
    isCapturing = false;
  }
}

function startScreenSharing(intervalMs = 2000) {
  if (screenInterval) clearInterval(screenInterval);
  captureAndSendScreen();
  screenInterval = setInterval(captureAndSendScreen, intervalMs);
  if (mainWindow) mainWindow.webContents.send('screen-sharing-status', true);
}

function stopScreenSharing() {
  if (screenInterval) {
    clearInterval(screenInterval);
    screenInterval = null;
  }
  if (mainWindow) mainWindow.webContents.send('screen-sharing-status', false);
}

function sendStudentRegistration() {
  if (socket && socket.connected) {
    const payload = {
      hostname: currentStudentName || os.hostname() || 'Estudiante-PC',
      ip: 'Cliente'
    };
    socket.emit('student-join', payload);
    socket.emit('register-student', payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    title: 'Aula Control — Aplicación Unificada (Estudiante & Maestro)',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopScreenSharing();
  });
}

app.whenReady().then(() => {
  createWindow();
  setupRadarDiscovery();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC para Iniciar Servidor Embebido al autenticar Maestro
ipcMain.handle('start-maestro-server', async () => {
  if (!embeddedServerStarted) {
    try {
      const serverModule = require('../server/index.js');
      await serverModule.startEmbeddedServer(3000);
      embeddedServerStarted = true;
      return { success: true, url: 'http://localhost:3000' };
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        embeddedServerStarted = true;
        return { success: true, url: 'http://localhost:3000', note: 'Servidor ya activo en puerto 3000' };
      }
      return { success: false, error: err.message };
    }
  }
  return { success: true, url: 'http://localhost:3000' };
});

// Obtener Source ID de la pantalla para WebRTC
ipcMain.handle('get-desktop-source-id', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (sources.length > 0) {
      return sources[0].id;
    }
    return null;
  } catch (err) {
    console.error('[Source ID Error]:', err);
    return null;
  }
});

ipcMain.handle('get-radar-peers', () => {
  return Array.from(discoveredRadarPeers.values());
});

// Manejo de Conexión Socket e IPC
ipcMain.handle('connect-server', (event, { serverUrl, hostname }) => {
  if (socket) {
    socket.disconnect();
  }

  const defaultName = os.hostname() || 'Estudiante-PC';
  currentStudentName = hostname && hostname.trim() ? hostname.trim() : defaultName;

  socket = io(serverUrl, {
    reconnection: true,
    reconnectionAttempts: 50,
    reconnectionDelay: 1000
  });

  socket.on('connect', () => {
    console.log('[Socket] Conectado exitosamente al servidor:', serverUrl);
    sendStudentRegistration();
    startScreenSharing(2000);
    if (mainWindow) mainWindow.webContents.send('connection-status', { connected: true, serverUrl });
  });

  socket.on('reconnect', () => {
    console.log('[Socket] Reconectado al servidor');
    sendStudentRegistration();
  });

  socket.on('sync-request', () => {
    console.log('[Socket] Re-sincronizando estado...');
    sendStudentRegistration();
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Desconectado del servidor');
    stopScreenSharing();
    if (mainWindow) mainWindow.webContents.send('connection-status', { connected: false });
  });

  socket.on('block-dns', (data = {}) => {
    blockDNS(data.domains || []);
    if (mainWindow) mainWindow.webContents.send('dns-status', { blocked: true });
  });

  socket.on('unblock-dns', () => {
    unblockDNS();
    if (mainWindow) mainWindow.webContents.send('dns-status', { blocked: false });
  });

  // --- SEÑALIZACIÓN WEBRTC PEER-TO-PEER EN EL CLIENTE ESTUDIANTE ---
  socket.on('webrtc-offer', (data) => {
    // Pasar la oferta WebRTC al proceso Renderer para contestar con el MediaStream de pantalla
    if (mainWindow) mainWindow.webContents.send('webrtc-offer-received', data);
  });

  socket.on('webrtc-candidate', (data) => {
    if (mainWindow) mainWindow.webContents.send('webrtc-candidate-received', data);
  });

  // Relay desde Renderer hacia Socket.io para la señalización
  ipcMain.on('send-webrtc-answer', (event, payload) => {
    if (socket && socket.connected) {
      socket.emit('webrtc-answer', payload);
    }
  });

  ipcMain.on('send-webrtc-candidate', (event, payload) => {
    if (socket && socket.connected) {
      socket.emit('webrtc-candidate', payload);
    }
  });

  // Relay desde Maestro Renderer hacia Socket.io para iniciar oferta WebRTC
  ipcMain.on('send-webrtc-offer', (event, payload) => {
    if (socket && socket.connected) {
      socket.emit('webrtc-offer', payload);
    }
  });

  socket.on('webrtc-answer', (data) => {
    if (mainWindow) mainWindow.webContents.send('webrtc-answer-received', data);
  });

  // --- EXPLORADOR DE ARCHIVOS REMOTO (FS ENGINE EN ESTUDIANTE) ---
  socket.on('fs-read-directory', (payload) => {
    const { requesterSocketId, dirPath } = payload;
    let targetPath = dirPath;

    if (!targetPath || targetPath === 'HOME' || targetPath === '.') {
      targetPath = os.homedir();
    } else if (targetPath === 'DOCUMENTS') {
      targetPath = path.join(os.homedir(), 'Documents');
    } else if (targetPath === 'DESKTOP') {
      targetPath = path.join(os.homedir(), 'Desktop');
    }

    try {
      const files = fs.readdirSync(targetPath, { withFileTypes: true });
      const items = files.map(f => {
        let size = 0;
        let mtime = null;
        try {
          const stat = fs.statSync(path.join(targetPath, f.name));
          size = stat.size;
          mtime = stat.mtime;
        } catch (e) {}

        return {
          name: f.name,
          isDirectory: f.isDirectory(),
          size,
          mtime
        };
      });

      socket.emit('fs-directory-result', {
        requesterSocketId,
        currentPath: targetPath,
        items
      });
    } catch (err) {
      socket.emit('fs-directory-result', {
        requesterSocketId,
        currentPath: targetPath,
        error: err.message,
        items: []
      });
    }
  });

  socket.on('fs-create-directory', (payload) => {
    const { requesterSocketId, parentPath, folderName } = payload;
    const newPath = path.join(parentPath, folderName);

    try {
      fs.mkdirSync(newPath, { recursive: true });
      socket.emit('fs-operation-result', {
        requesterSocketId,
        success: true,
        message: `Carpeta '${folderName}' creada exitosamente.`
      });
    } catch (err) {
      socket.emit('fs-operation-result', {
        requesterSocketId,
        success: false,
        message: err.message
      });
    }
  });

  socket.on('fs-upload-file', (payload) => {
    const { requesterSocketId, targetPath, fileName, fileBase64 } = payload;
    const destPath = path.join(targetPath, fileName);

    try {
      const buffer = Buffer.from(fileBase64, 'base64');
      fs.writeFileSync(destPath, buffer);
      socket.emit('fs-operation-result', {
        requesterSocketId,
        success: true,
        message: `Archivo '${fileName}' subido exitosamente a ${targetPath}.`
      });
    } catch (err) {
      socket.emit('fs-operation-result', {
        requesterSocketId,
        success: false,
        message: err.message
      });
    }
  });

  // Relay desde Maestro hacia Servidor para comandos FS
  ipcMain.on('request-fs-read-directory', (e, data) => {
    if (socket && socket.connected) socket.emit('fs-read-directory', data);
  });
  ipcMain.on('request-fs-create-directory', (e, data) => {
    if (socket && socket.connected) socket.emit('fs-create-directory', data);
  });
  ipcMain.on('request-fs-upload-file', (e, data) => {
    if (socket && socket.connected) socket.emit('fs-upload-file', data);
  });

  socket.on('fs-directory-result', (data) => {
    if (mainWindow) mainWindow.webContents.send('fs-directory-result', data);
  });
  socket.on('fs-operation-result', (data) => {
    if (mainWindow) mainWindow.webContents.send('fs-operation-result', data);
  });

  socket.on('chat-message', (data) => {
    if (mainWindow) mainWindow.webContents.send('chat-message', data);
  });

  socket.on('students-list', (list) => {
    if (socket && socket.id) {
      const self = list.find(s => s.id === socket.id);
      if (self && mainWindow) {
        mainWindow.webContents.send('hand-status', self.handRaised);
      }
    }
  });

  return { success: true };
});

ipcMain.handle('get-default-hostname', () => {
  return os.hostname() || 'Estudiante-PC';
});

ipcMain.handle('toggle-hand', () => {
  if (socket && socket.connected) {
    socket.emit('toggle-hand');
    return { success: true };
  }
  return { success: false, error: 'No conectado al servidor' };
});

ipcMain.handle('send-chat', (event, message) => {
  if (socket && socket.connected) {
    socket.emit('chat-message', { message });
    return { success: true };
  }
  return { success: false, error: 'No conectado al servidor' };
});
