const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const http = require('http');
const { exec } = require('child_process');
const io = require('socket.io-client');

// Identificador único de instancia para evitar auto-bucles de conexión
const appInstanceId = Math.random().toString(36).substring(2) + Date.now().toString(36);

let mainWindow = null;
let socket = null;
let screenInterval = null;
let currentStudentName = '';
let isCapturing = false;
let isMaestroMode = false; // AISLAMIENTO DE ROLES: Modo Maestro activo

// Radar UDP & Scanner State
const RADAR_PORT = 41234;
let udpSocket = null;
let maestroDiscovered = false;
let autoConnectActive = true;
let fallbackScanTimer = null;
let forceConnectHttpServer = null;

let embeddedServerStarted = false;

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

// Servidor HTTP en puerto 3001 para enlace forzado desde el Maestro
function setupForceConnectListener() {
  try {
    forceConnectHttpServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
      }

      if (req.url.startsWith('/api/request-socket-connect')) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          let maestroUrl = null;
          try {
            const data = JSON.parse(body);
            maestroUrl = data.maestroUrl;
          } catch (e) {
            const urlObj = new URL(req.url, 'http://localhost:3001');
            maestroUrl = urlObj.searchParams.get('maestroUrl');
          }

          if (maestroUrl && !isMaestroMode) {
            console.log(`[Force Connect] Petición recibida del Maestro para conectar a: ${maestroUrl}`);
            notifyMaestroDiscovered(maestroUrl.replace(/^https?:\/\//, '').split(':')[0], 3000, 'Maestro-PC', 'FORCE_LINK');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: 'Enlazado correctamente.' }));
          }

          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Acción no permitida o maestroUrl invalido' }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    forceConnectHttpServer.listen(3001, () => {
      console.log('[Force Connect Listener] Escuchando en puerto 3001');
    });
  } catch (err) {
    console.warn('[Force Connect Listener Error]:', err.message);
  }
}

// --- RECEPCIÓN DE RADAR UDP MAESTRO ---
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
          // FILTRADO DE AUTO-IDENTIFICACIÓN: Ignorar si es la propia instancia o si la app está en Modo Maestro
          if (data.instanceId === appInstanceId || isMaestroMode) {
            return;
          }

          const maestroIp = rinfo.address;
          const maestroPort = data.port || 3000;

          if (!maestroDiscovered) {
            maestroDiscovered = true;
            notifyMaestroDiscovered(maestroIp, maestroPort, data.name || 'Maestro-PC', 'UDP_RADAR');
          }
        }
      } catch (e) {}
    });

    udpSocket.bind(RADAR_PORT, () => {
      udpSocket.setBroadcast(true);
      console.log(`[Radar UDP Student] Escuchando en puerto UDP ${RADAR_PORT} (Instance ID: ${appInstanceId})`);
    });

  } catch (err) {
    console.warn('[Radar Setup Error]:', err.message);
  }

  fallbackScanTimer = setTimeout(() => {
    if (!maestroDiscovered && !isMaestroMode) {
      console.log('[Radar Fallback] Sin respuesta UDP Multicast en 5s. Iniciando escaneo de subred local HTTP...');
      runSubnetScanFallback();
    }
  }, 5000);
}

// --- FALLBACK: ESCANEO DE SUBRED LOCAL HTTP (/api/identity) ---
function runSubnetScanFallback() {
  if (maestroDiscovered || isMaestroMode) return;

  const interfaces = os.networkInterfaces();
  const subnetsToScan = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
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

  if (subnetsToScan.length === 0) return;

  subnetsToScan.forEach(subnet => {
    for (let i = 1; i <= 254; i++) {
      if (maestroDiscovered || isMaestroMode) break;
      const targetIp = `${subnet}.${i}`;
      checkMaestroIdentityHttp(targetIp, 3000);
    }
  });
}

function checkMaestroIdentityHttp(targetIp, port = 3000) {
  if (maestroDiscovered || isMaestroMode) return;

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
        if (data && data.service === 'AULA_CONTROL_MASTER' && !maestroDiscovered && !isMaestroMode) {
          if (data.instanceId === appInstanceId) return; // Ignorar si es uno mismo

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
  if (isMaestroMode) return; // Jamás conectar si se está actuando como Maestro
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

  if (autoConnectActive) {
    connectToMaestroSocket(url);
  }
}

// Modificar hosts
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

async function captureAndSendScreen() {
  if (isCapturing || isMaestroMode) return;
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
  if (isMaestroMode) return;
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
  if (socket && socket.connected && !isMaestroMode) {
    const localIp = getLocalIPv4Address();
    const payload = {
      hostname: currentStudentName || os.hostname() || 'Estudiante-PC',
      ip: localIp,
      status: 'online'
    };
    socket.emit('register-student', payload);
    socket.emit('student-join', payload);
  }
}

function connectToMaestroSocket(serverUrl) {
  if (isMaestroMode) {
    console.log('[AISLAMIENTO] En Modo Maestro no se permite conectar como cliente Socket.io.');
    return;
  }

  if (socket) {
    socket.disconnect();
  }

  socket = io(serverUrl, {
    reconnection: true,
    reconnectionAttempts: 50,
    reconnectionDelay: 1000
  });

  socket.on('connect', () => {
    console.log('[Socket Estudiante] Conectado al servidor maestro:', serverUrl);
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

  // WebRTC Signal Relays
  socket.on('webrtc-offer', (data) => {
    if (mainWindow) mainWindow.webContents.send('webrtc-offer-received', data);
  });

  socket.on('webrtc-candidate', (data) => {
    if (mainWindow) mainWindow.webContents.send('webrtc-candidate-received', data);
  });

  socket.on('webrtc-answer', (data) => {
    if (mainWindow) mainWindow.webContents.send('webrtc-answer-received', data);
  });

  // FS Engine
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

  socket.on('update-student-list', (list) => {
    if (mainWindow) mainWindow.webContents.send('update-student-list', list);
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
  setupForceConnectListener();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers
ipcMain.handle('start-maestro-server', async () => {
  // AISLAMIENTO DE ROLES: Activar Modo Maestro
  isMaestroMode = true;

  // Desconectar cliente Socket.io del estudiante de forma segura
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  stopScreenSharing();

  if (!embeddedServerStarted) {
    try {
      const serverModule = require('../server/index.js');
      await serverModule.startEmbeddedServer(3000, appInstanceId);
      embeddedServerStarted = true;
      return { success: true, url: 'http://localhost:3000' };
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        embeddedServerStarted = true;
        return { success: true, url: 'http://localhost:3000', note: 'Servidor activo' };
      }
      return { success: false, error: err.message };
    }
  }
  return { success: true, url: 'http://localhost:3000' };
});

ipcMain.handle('stop-maestro-server', async () => {
  // AISLAMIENTO DE ROLES: Salir del Modo Maestro
  isMaestroMode = false;
  maestroDiscovered = false;

  try {
    const serverModule = require('../server/index.js');
    if (serverModule.stopEmbeddedServer) {
      serverModule.stopEmbeddedServer();
    }
  } catch (e) {}

  embeddedServerStarted = false;

  // Reactivar escaneo Radar para Modo Estudiante
  if (fallbackScanTimer) clearTimeout(fallbackScanTimer);
  runSubnetScanFallback();

  return { success: true };
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
  if (isMaestroMode) return { success: false, error: 'En Modo Maestro no se conecta como cliente.' };
  const defaultName = os.hostname() || 'Estudiante-PC';
  currentStudentName = hostname && hostname.trim() ? hostname.trim() : defaultName;
  connectToMaestroSocket(serverUrl);
  return { success: true };
});

ipcMain.handle('disconnect-server', () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  stopScreenSharing();
  return { success: true };
});

ipcMain.handle('restart-radar-search', () => {
  if (isMaestroMode) return { success: false };
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
