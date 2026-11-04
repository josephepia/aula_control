# AGENTS.md - Sistema de Control y Colaboración de Aula

## Objetivo
Construir un MVP de control de aula antes de las 3:00 PM. Priorizar código funcional, simple y autónomo sin dependencias complejas de compilación nativa.

## Arquitectura del Proyecto

### 1. Servidor / Panel Maestro (`/server`)
- Tecnologías: Node.js, Express, Socket.io.
- Puerto por defecto: `3000`.
- Funcionalidades:
  - Servir la interfaz web del maestro (`public/index.html`).
  - Gestionar conexiones WebSocket de los clientes estudiante.
  - Mantener lista de estudiantes activos (IP, Nombre de Equipo, Estado de Mano Levantada).
  - Emitir comandos broadcast o individuales: `block-dns`, `unblock-dns`, `request-screen`.
  - Recibir y retransmitir mensajes del chat global.

### 2. Cliente Estudiante (`/student-app`)
- Tecnologías: Electron (Node.js + Chromium).
- Funcionalidades en `main.js`:
  - Conectar automáticamente vía WebSocket al IP del Maestro.
  - Escuchar evento `block-dns`: Modificar `C:\Windows\System32\drivers\etc\hosts` (en Windows) o `/etc/hosts` (en Unix) agregando la lista de dominios apuntando a `127.0.0.1`. Manejar permisos con fallback o ejecución de comandos shell (`sudo` / `cmd`).
  - Escuchar evento `unblock-dns`: Limpiar las entradas añadidas al archivo `hosts`.
  - Captura de pantalla básica con `desktopCapturer` de Electron y envío de fotogramas (WebSockets/base64 o WebRTC sencillo).
- Funcionalidades en UI (`index.html`):
  - Botón "Alzar la mano" (toggle de estado vía Socket.io).
  - Componente de Chat en vivo.

## Reglas de Generación de Código
1. Escribir código JavaScript directo (ES6+), sin TypeScript ni pasos de compilación complejos para ahorrar tiempo.
2. Usar `npm scripts` simples en el `package.json` de la raíz para iniciar servidor y cliente.
3. Asegurar que las rutas a los archivos `hosts` detecten el sistema operativo (`process.platform`).