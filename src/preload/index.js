const { contextBridge, ipcRenderer } = require('electron');

// 只暴露最底层的串口字节通道，协议与会话状态机放在渲染进程的 src/core 里，
// 与 Web 版共用同一套代码（见 src/transport/index.js）。
contextBridge.exposeInMainWorld('nativeSerial', {
  list: () => ipcRenderer.invoke('serial:list'),
  open: (id) => ipcRenderer.invoke('serial:open', id),
  write: (text) => ipcRenderer.send('serial:write', text),
  close: () => ipcRenderer.invoke('serial:close'),

  onData: (cb) => ipcRenderer.on('serial:data', (_e, chunk) => cb(chunk)),
  onError: (cb) => ipcRenderer.on('serial:error', (_e, msg) => cb(msg)),
  onClose: (cb) => ipcRenderer.on('serial:closed', () => cb()),
});
