const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studentAPI', {
  // Conexión y Básicos
  connectServer: (data) => ipcRenderer.invoke('connect-server', data),
  disconnectServer: () => ipcRenderer.invoke('disconnect-server'),
  getDefaultHostname: () => ipcRenderer.invoke('get-default-hostname'),
  toggleHand: () => ipcRenderer.invoke('toggle-hand'),
  sendChat: (message) => ipcRenderer.invoke('send-chat', message),
  startMaestroServer: () => ipcRenderer.invoke('start-maestro-server'),

  // Radar UDP y Auto-Descubrimiento
  restartRadarSearch: () => ipcRenderer.invoke('restart-radar-search'),
  onMaestroAutoDiscovered: (callback) => {
    ipcRenderer.on('maestro-auto-discovered', (event, data) => callback(data));
  },

  // WebRTC Native Stream
  getDesktopSourceId: () => ipcRenderer.invoke('get-desktop-source-id'),
  sendWebRTCOffer: (data) => ipcRenderer.send('send-webrtc-offer', data),
  sendWebRTCAnswer: (data) => ipcRenderer.send('send-webrtc-answer', data),
  sendWebRTCCandidate: (data) => ipcRenderer.send('send-webrtc-candidate', data),

  onWebRTCOfferReceived: (callback) => {
    ipcRenderer.on('webrtc-offer-received', (event, data) => callback(data));
  },
  onWebRTCAnswerReceived: (callback) => {
    ipcRenderer.on('webrtc-answer-received', (event, data) => callback(data));
  },
  onWebRTCCandidateReceived: (callback) => {
    ipcRenderer.on('webrtc-candidate-received', (event, data) => callback(data));
  },

  // Gestor de Archivos Remoto (FS)
  requestFSReadDir: (data) => ipcRenderer.send('request-fs-read-directory', data),
  requestFSCreateDir: (data) => ipcRenderer.send('request-fs-create-directory', data),
  requestFSUploadFile: (data) => ipcRenderer.send('request-fs-upload-file', data),

  onFSDirectoryResult: (callback) => {
    ipcRenderer.on('fs-directory-result', (event, data) => callback(data));
  },
  onFSOperationResult: (callback) => {
    ipcRenderer.on('fs-operation-result', (event, data) => callback(data));
  },

  // Eventos de Estado
  onConnectionStatus: (callback) => {
    ipcRenderer.on('connection-status', (event, data) => callback(data));
  },
  onUpdateStudentList: (callback) => {
    ipcRenderer.on('update-student-list', (event, data) => callback(data));
  },
  onDNSStatus: (callback) => {
    ipcRenderer.on('dns-status', (event, data) => callback(data));
  },
  onScreenSharingStatus: (callback) => {
    ipcRenderer.on('screen-sharing-status', (event, data) => callback(data));
  },
  onChatMessage: (callback) => {
    ipcRenderer.on('chat-message', (event, data) => callback(data));
  },
  onHandStatus: (callback) => {
    ipcRenderer.on('hand-status', (event, isHandRaised) => callback(isHandRaised));
  }
});
