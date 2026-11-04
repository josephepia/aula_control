const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const http = require('http');
const { exec } = require('child_process');
const io = require('socket.io-client');

let mainWindow = null;
let socket = null;
let screenInterval = null;
let currentStudentName = '';
let isCapturing = false;

// Radar UDP & Scanner State
const RADAR_PORT = 41234;
let udpSocket = null;
let maestroDiscovered = false;
let autoConnectActive = true;
let fallbackScanTimer = null;

// Servidor local embebido si se activa modo Maestro
let embeddedServerStarted = false;

// --- 1. RECEPCIÓN DE RADAR UDP MAESTRO ---
function setupRadarListener() {
  try {
    udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    udpSocket.on('error', (err) => {
      console.warn('[Radar UDP Student Warning]:', err.message);
    });

    udpSocket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data && data.service === 'AULA_CONTROL_MASTER') {
          const maestroIp = rinfo.address;
          const maestroPort = data.port || 3000;
          const maestroUrl = `http://${maestroIp}:${maestroPort}`;

          if (!maestroDiscovered) {
            maestroDiscovered = true;
            console.log(`[Radar UDP] Maestro detectado en: ${maestroUrl} (${data.name || 'Maestro-PC'})`);
            notifyMaestroDiscovered(maestroIp, maestroPort, data.name || 'Maestro-PC', 'UDP_RADAR');
          }
        }
      } catch (e) {
        // Ignorar paquetes no válidos
      }
    });

    udpSocket.bind(RADAR_PORT, () => {
      udpSocket.setBroadcast(true);
      console.log(`[Radar UDP Student] Escuchando maestro en puerto UDP ${RADAR_PORT}`);
    });

  } catch (err) {
    console.warn('[Radar Setup Error]:', err.message);
  }

  // 2. Programar Fallback de Escaneo en Subred Local si no hay respuesta en 5 segundos
  fallbackScanTimer = setTimeout(() => {
    if (!maestroDiscovered) {
      console.log('[Radar Fallback] Sin respuesta UDP Multicast en 5s. Iniciando escaneo de subred local HTTP...');
      runSubnetScanFallback();
    }
  }, 5000);
}

// --- 3. FALLBACK: ESCANEO DE SUBRED LOCAL HTTP (/api/identity) ---
function runSubnetScanFallback() {
  if (maestroDiscovered) return;

  const interfaces = os.networkInterfaces();
  const subnetsToScan = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Filtrar IPv4 internas (ej. 192.168.X.X, 10.X.X.X, 172.16.X.X)
      if (net.family === 'IPv4' && !net.internal) {
        const ipParts = net.address.split('.');
        if (ipParts.length === 4) {
          const subnetPrefix = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;
          if (!subnetsToScan.includes(subnetPrefix)) {
            subnetsToScan.push(subnetPrefix);
          }
        }
      }
    }
  }

  if (subnetsToScan.length === 0) {
    console.log('[Subnet Scan] No se detectaron interfaces de red locales activas.');
    return;
  }

  subnetsToScan.forEach(subnet => {
    console.log(`[Subnet Scan] Escaneando subred: ${subnet}.1 a ${subnet}.254 en puerto 3000...`);
    for (let i = 1; i <= 254; i++) {
      if (maestroDiscovered) break;
      const targetIp = `${subnet}.${i}`;
      checkMaestroIdentityHttp(targetIp, 3000);
    }
  });
}

function checkMaestroIdentityHttp(targetIp, port = 3000) {
  if (maestroDiscovered) return;

  const options = {
    hostname: targetIp,
    port: port,
    path: '/api/identity',
    method: 'GET',
    timeout: 700
  };

  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data && data.service === 'AULA_CONTROL_MASTER' && !maestroDiscovered) {
          maestroDiscovered = true;
          console.log(`[Subnet Scan Éxito] Maestro hallado en ${targetIp}:${port}`);
          notifyMaestroDiscovered(targetIp, port, data.name || 'Maestro-PC', 'SUBNET_SCAN');
        }
      } catch (e) {}
    });
  });

  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
}

function notifyMaestroDiscovered(ip, port, name, method) {
  const url = `http://${ip}:${port}`;

  if (mainWindow) {
    mainWindow.webContents.send('maestro-auto-discovered', {
      ip,
      port,
      name,
      method,
      url,
      statusMessage: `🟢 Conectado a Maestro en ${ip}`
    });
  }

  // Auto-conectar automáticamente WebSocket si está activo
  if (autoConnectActive) {
    connectToMaestroSocket(url);
  }
}

// --- CONEXIÓN AUTOMÁTICA Y LÓGICA DE ELECTRON ---
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

function connectToMaestroSocket(serverUrl) {
  if (socket) {
    socket.disconnect();
  }

  socket = io(serverUrl, {
    reconnection: true,
    reconnectionAttempts: 50,
    reconnectionDelay: 1000
  });

  socket.on('connect', () => {
    console.log('[Socket] Conectado exitosamente al servidor maestro:', serverUrl);
    sendStudentRegistration();
    startScreenSharing(2000);
    if (mainWindow) {
      mainWindow.webContents.send('connection-status', {
        connected: true,
        serverUrl,
        statusText: `🟢 Conectado a Maestro en ${serverUrl}`
      });
    }
  });

  socket.on('reconnect', () => {
    sendStudentRegistration();
  });

  socket.on('sync-request', () => {
    sendStudentRegistration();
  });

  socket.on('disconnect', () => {
    stopScreenSharing();
    if (mainWindow) {
      mainWindow.webContents.send('connection-status', {
        connected: false,
        statusText: '🟡 Buscando Maestro en la red (Radar activo)...'
      });
    }
  });

  socket.on('block-dns', (data = {}) => {
    blockDNS(data.domains || []);
    if (mainWindow) mainWindow.webContents.send('dns-status', { blocked: true });
  });

  socket.on('unblock-dns', () => {
    unblockDNS();
    if (mainWindow) mainWindow.webContents.send('dns-status', { blocked: false });
  });

  // --- SEÑALIZACIÓN WEBRTC PEER-TO-PEER ---
  socket.on('webrtc-offer', (data) => {
    if (mainWindow) mainWindow.webContents.send('webrtc-offer-received', data);
  });

  socket.on('webrtc-candidate', (data) => {
    if (mainWindow) mainWindow.webContents.send('webrtc-candidate-received', data);
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
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 740,
    title: 'Aula Control — Aplicación Unificada',
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
  setupRadarListener();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers
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

ipcMain.handle('get-desktop-source-id', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (sources.length > 0) return sources[0].id;
    return null;
  } catch (err) {
    return null;
  }
});

ipcMain.handle('connect-server', (event, { serverUrl, hostname }) => {
  const defaultName = os.hostname() || 'Estudiante-PC';
  currentStudentName = hostname && hostname.trim() ? hostname.trim() : defaultName;
  connectToMaestroSocket(serverUrl);
  return { success: true };
});

ipcMain.handle('restart-radar-search', () => {
  maestroDiscovered = false;
  if (fallbackScanTimer) clearTimeout(fallbackScanTimer);
  runSubnetScanFallback();
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

ipcMain.on('send-webrtc-answer', (event, payload) => {
  if (socket && socket.connected) socket.emit('webrtc-answer', payload);
});

ipcMain.on('send-webrtc-candidate', (event, payload) => {
  if (socket && socket.connected) socket.emit('webrtc-candidate', payload);
});

ipcMain.on('send-webrtc-offer', (event, payload) => {
  if (socket && socket.connected) socket.emit('webrtc-offer', payload);
});

ipcMain.on('request-fs-read-directory', (e, data) => {
  if (socket && socket.connected) socket.emit('fs-read-directory', data);
});
ipcMain.on('request-fs-create-directory', (e, data) => {
  if (socket && socket.connected) socket.emit('fs-create-directory', data);
});
ipcMain.on('request-fs-upload-file', (e, data) => {
  if (socket && socket.connected) socket.emit('fs-upload-file', data);
});
