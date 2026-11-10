const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SerialPort } = require('serialport');

const BAUD_RATE = 115200;
const OPEN_TIMEOUT_MS = 3000; // 打开端口本身的超时

let win = null;
let port = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 670,
    center: true,
    resizable: false,
    autoHideMenuBar: true,
    title: 'Pocket Master Custom Control',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 会话层（心跳等）跑在渲染进程，后台不要被节流
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// ---------------- 串口字节桥 ----------------
// 本进程只负责“打开/写/读/关”的字节搬运，协议与状态机都在渲染进程的 src/core 里。

function detach() {
  const p = port;
  port = null;
  if (p) {
    p.removeAllListeners();
    try {
      if (p.isOpen) p.close();
    } catch (_) {
      /* 忽略关闭失败 */
    }
  }
}

ipcMain.handle('serial:list', async () => {
  let ports = [];
  try {
    ports = await SerialPort.list();
  } catch (_) {
    ports = [];
  }
  return ports.map((p) => ({
    id: p.path,
    label: p.friendlyName || p.path,
    vendorId: p.vendorId || '',
    manufacturer: p.manufacturer || '',
    pnpId: p.pnpId || '',
  }));
});

ipcMain.handle(
  'serial:open',
  (_e, id) =>
    new Promise((resolve, reject) => {
      detach();

      const p = new SerialPort({ path: id, baudRate: BAUD_RATE, autoOpen: false });
      let settled = false;
      const guard = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          p.close();
        } catch (_) {
          /* 忽略 */
        }
        reject(new Error('打开串口超时'));
      }, OPEN_TIMEOUT_MS);

      p.open((err) => {
        if (settled) return;
        if (err) {
          settled = true;
          clearTimeout(guard);
          reject(err);
          return;
        }
        settled = true;
        clearTimeout(guard);

        port = p;
        p.on('data', (chunk) => send('serial:data', chunk.toString('utf8')));
        p.on('error', (e) => send('serial:error', e.message));
        p.on('close', () => {
          detach();
          send('serial:closed');
        });
        // 尽量避免主机侧 DTR/RTS 抖动影响芯片
        p.set({ dtr: false, rts: false }, () => {});
        resolve();
      });
    })
);

ipcMain.on('serial:write', (_e, text) => {
  if (!port || !port.isOpen) return;
  port.write(text, (err) => {
    if (err) send('serial:error', err.message);
  });
});

ipcMain.handle('serial:close', () => {
  detach();
});

// ---------------- 生命周期 ----------------

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  detach();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => detach());
