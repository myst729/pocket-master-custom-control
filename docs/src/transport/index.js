// 传输层：把两种底层串口通道统一成同一组接口，供 src/core/client.js 使用。
//
//   Electron: window.nativeSerial（preload 暴露）-> 主进程 node-serialport
//   Web:      navigator.serial（Web Serial API，仅桌面版 Chrome / Edge）
//
// 统一接口（契约见 src/core/client.js 顶部注释）：
//   list()             -> Promise<[{ id, label, vendorId, manufacturer, pnpId }]>
//   open(id)           -> Promise<void>
//   write(text)        -> void
//   close()            -> Promise<void>
//   onData(cb) / onError(cb) / onClose(cb)
//   requestPort?()     -> Promise<{ id, label } | null>
//   requiresUserGesture
//
// 包一层 IIFE，避免与其他以 <script> 方式共存的模块发生顶层名字冲突。
(function () {
  const BAUD_RATE = 115200;
  const OPEN_TIMEOUT_MS = 3000; // 打开端口本身的超时

  function makeEmitter() {
    const cbs = { data: [], error: [], close: [] };
    return {
      onData: (cb) => cbs.data.push(cb),
      onError: (cb) => cbs.error.push(cb),
      onClose: (cb) => cbs.close.push(cb),
      emit: (name, payload) => {
        for (const cb of cbs[name]) cb(payload);
      },
    };
  }

  // ---------------- Electron：走主进程 node-serialport ----------------

  function createElectronTransport(nativeSerial) {
    const bus = makeEmitter();
    nativeSerial.onData((chunk) => bus.emit('data', chunk));
    nativeSerial.onError((msg) => bus.emit('error', msg));
    nativeSerial.onClose(() => bus.emit('close'));

    return {
      requiresUserGesture: false,
      list: () => nativeSerial.list(),
      open: (id) => nativeSerial.open(id),
      write: (text) => nativeSerial.write(text),
      close: () => nativeSerial.close(),
      onData: bus.onData,
      onError: bus.onError,
      onClose: bus.onClose,
    };
  }

  // ---------------- Web：走 navigator.serial ----------------

  function createWebSerialTransport() {
    const bus = makeEmitter();
    const hex = (n) => Number(n).toString(16).padStart(4, '0');

    // navigator.serial 给的是 SerialPort 对象而不是路径，这里自己维护 id <-> 对象映射
    const idOf = new Map();
    const portOf = new Map();
    let seq = 0;

    let port = null;
    let reader = null;
    let closing = false;
    let decoder = null;
    let writeChain = Promise.resolve();

    function labelOf(p) {
      const info = (p && p.getInfo && p.getInfo()) || {};
      if (info.usbVendorId === 0x303a) return `ESP32 串口 (${hex(info.usbVendorId)}:${hex(info.usbProductId)})`;
      if (info.usbVendorId) return `串口 (${hex(info.usbVendorId)}:${hex(info.usbProductId)})`;
      return '串口设备';
    }

    function ensureId(p) {
      if (!idOf.has(p)) {
        const id = 'p' + ++seq;
        idOf.set(p, id);
        portOf.set(id, p);
      }
      return idOf.get(p);
    }

    function onDisconnect() {
      if (closing) return;
      port = null;
      bus.emit('close');
    }

    // 持续读：数据块可能在任何位置被切开，交给 core 的分行器去拼
    async function readLoop(p) {
      while (port === p && p.readable) {
        reader = p.readable.getReader();
        try {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) bus.emit('data', decoder.decode(value, { stream: true }));
        } catch (e) {
          if (!closing) bus.emit('error', e.message || String(e));
          break;
        } finally {
          reader.releaseLock();
        }
      }
    }

    return {
      requiresUserGesture: true,

      async list() {
        if (!navigator.serial) return [];
        const ports = await navigator.serial.getPorts(); // 已授权过的端口，无需用户手势
        return ports.map((p) => {
          const info = (p.getInfo && p.getInfo()) || {};
          return {
            id: ensureId(p),
            label: labelOf(p),
            vendorId: info.usbVendorId ? hex(info.usbVendorId) : '',
            manufacturer: '',
            pnpId: '',
          };
        });
      },

      async open(id) {
        const p = portOf.get(id);
        if (!p) throw new Error('未找到该串口');

        await Promise.race([
          p.open({ baudRate: BAUD_RATE, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('打开串口超时')), OPEN_TIMEOUT_MS)),
        ]);

        port = p;
        closing = false;
        decoder = new TextDecoder();
        p.addEventListener('disconnect', onDisconnect);
        // 尽量避免主机侧 DTR/RTS 抖动影响芯片
        try {
          await p.setSignals({ dataTerminalReady: false, requestToSend: false });
        } catch (_) {
          /* 部分平台不支持设置信号线，忽略 */
        }
        readLoop(p);
      },

      write(text) {
        writeChain = writeChain
          .then(async () => {
            if (!port) throw new Error('串口未打开');
            const w = port.writable.getWriter();
            try {
              await w.write(new TextEncoder().encode(text));
            } finally {
              w.releaseLock();
            }
          })
          .catch((e) => bus.emit('error', e.message || String(e)));
      },

      async close() {
        closing = true;
        const p = port;
        port = null;
        if (!p) return;
        p.removeEventListener('disconnect', onDisconnect);
        try {
          if (reader) await reader.cancel();
        } catch (_) {
          /* 忽略 */
        }
        reader = null;
        try {
          await p.close();
        } catch (_) {
          /* 忽略关闭失败 */
        }
      },

      // 必须在用户手势（click）中直接调用，否则浏览器会拒绝
      async requestPort() {
        if (!navigator.serial) return null;
        const p = await navigator.serial.requestPort();
        return { id: ensureId(p), label: labelOf(p) };
      },

      onData: bus.onData,
      onError: bus.onError,
      onClose: bus.onClose,
    };
  }

  // 根据运行环境挑选传输层；都不支持时返回 null
  function createTransport() {
    if (typeof window !== 'undefined' && window.nativeSerial) {
      return createElectronTransport(window.nativeSerial);
    }
    if (typeof navigator !== 'undefined' && navigator.serial) {
      return createWebSerialTransport();
    }
    return null;
  }

  window.createTransport = createTransport;
})();
