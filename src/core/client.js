// 平台无关的设备会话层：请求排队、响应匹配、心跳、扫描自动连接。
// 它不认识具体串口实现，只依赖一个 transport 对象（见 src/transport/index.js）：
//   list()        -> Promise<[{ id, label, vendorId, manufacturer, pnpId }]>
//   open(id)      -> Promise<void>   打开失败时抛错
//   write(text)   -> void
//   close()       -> Promise<void>
//   onData(cb) / onError(cb) / onClose(cb)
//   requestPort?() -> Promise<{ id, label } | null>   需要用户手势选设备时使用（Web Serial）
//   requiresUserGesture -> boolean
//
// 对外暴露与旧版 window.midiConfig 完全一致的接口，UI 层无需改动。
// 包一层 IIFE，避免与其他以 <script> 方式共存的模块发生顶层名字冲突。
(function () {
  const OPEN_SETTLE_MS = 300; // 打开端口后静默期，避开 DTR/RTS 抖动
  const AUTO_OPEN_SETTLE_MS = 200;
  const AUTO_PING_MS = 1200; // 单端口探测超时
  const HEARTBEAT_MS = 2000; // 已连接后每隔多久 ping 一次
  const HEARTBEAT_MAX_FAILS = 2; // 心跳连续失败几次判定为已断开
  const REQUEST_TIMEOUT_MS = 1500; // 单条命令等待响应的默认超时

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 优先尝试像 ESP32 原生 USB 串口的端口
  function portScore(p) {
    const text = `${p.manufacturer || ''} ${p.label || ''} ${p.pnpId || ''}`.toLowerCase();
    let score = 0;
    if (text.includes('espressif')) score += 10;
    if (String(p.vendorId || '').toLowerCase() === '303a') score += 10;
    if (text.includes('usb')) score += 2;
    return score;
  }

  function createClient(transport) {
    const listeners = { status: [], line: [], tx: [], closed: [], error: [] };
    const emit = (name, payload) => {
      for (const cb of listeners[name]) cb(payload);
    };

    const reader = window.MidiProtocol.createLineReader();
    let pending = null; // { resolve, reject, quiet, timer }
    let queue = Promise.resolve();
    let autoConnecting = false;
    let heartbeatTimer = null;
    let heartbeatFails = 0;

    transport.onData((chunk) => {
      for (const line of reader.push(chunk)) {
        const obj = window.MidiProtocol.parseResponseLine(line);
        if (obj !== null && pending) {
          const p = pending;
          pending = null;
          clearTimeout(p.timer);
          if (!p.quiet) emit('line', line); // 心跳等静默请求不回显
          p.resolve(obj);
        } else {
          emit('line', line);
        }
      }
    });
    transport.onError((msg) => emit('error', msg));
    transport.onClose(() => {
      closeSession('串口已断开');
      if (!autoConnecting) emit('closed'); // 探测过程中的开关端口不算断开
    });

    // 清理会话状态（不主动关端口）
    function closeSession(reason) {
      stopHeartbeat();
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason || '串口已关闭'));
        pending = null;
      }
      reader.reset();
    }

    async function closePort(reason) {
      closeSession(reason);
      try {
        await transport.close();
      } catch (_) {
        /* 忽略关闭失败 */
      }
    }

    async function openPort(id, settleMs) {
      await closePort();
      await transport.open(id);
      await sleep(settleMs);
    }

    // 单命令 = 单响应，串行排队，避免响应错位。quiet=true 时不向界面回显收发内容（如心跳）。
    function request(cmdObj, timeoutMs = REQUEST_TIMEOUT_MS, opts = {}) {
      const quiet = !!opts.quiet;
      const run = () =>
        new Promise((resolve, reject) => {
          const line = JSON.stringify(cmdObj);
          pending = {
            resolve,
            reject,
            quiet,
            timer: setTimeout(() => {
              pending = null;
              reject(new Error('等待设备响应超时'));
            }, Math.max(1, timeoutMs)),
          };
          try {
            if (!quiet) emit('tx', line);
            transport.write(line + '\n');
          } catch (e) {
            clearTimeout(pending.timer);
            pending = null;
            reject(e);
          }
        });

      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    }

    function stopHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      heartbeatFails = 0;
    }

    // 已连接后持续 ping：设备被拔掉时端口不一定触发 close，靠心跳兜底。
    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setInterval(async () => {
        if (pending) return; // 有命令在途时跳过本次心跳

        let ok = false;
        try {
          const res = await request({ cmd: 'ping' }, AUTO_PING_MS, { quiet: true });
          ok = !!(res && res.ok === true);
        } catch (_) {
          ok = false;
        }

        if (ok) {
          heartbeatFails = 0;
          return;
        }
        if (++heartbeatFails < HEARTBEAT_MAX_FAILS) return;

        stopHeartbeat();
        await closePort('设备无响应');
        emit('closed');
      }, HEARTBEAT_MS);
    }

    async function probe(id, deadline) {
      await openPort(id, AUTO_OPEN_SETTLE_MS);
      const budget = Math.min(AUTO_PING_MS, deadline - Date.now());
      if (budget <= 0) throw new Error('已超时');
      const res = await request({ cmd: 'ping' }, budget);
      // 必须同时满足 ok 和设备标识，否则视为其他 ESP32 项目
      if (!window.MidiProtocol.isTargetDevice(res)) throw new Error('非目标设备');
      return res;
    }

    // 单次扫描：枚举所有串口，逐个探测。成功即返回；都没找到则返回 ok:false。
    // 调用方（UI 层）会每隔 1 秒再调一次，形成“持续尝试连接”。
    async function autoconnect() {
      autoConnecting = true;
      try {
        let ports = [];
        try {
          ports = await transport.list();
        } catch (_) {
          ports = [];
        }
        ports.sort((a, b) => portScore(b) - portScore(a));

        for (const p of ports) {
          emit('status', { phase: 'trying', path: p.label || p.id });
          try {
            const res = await probe(p.id, Date.now() + AUTO_PING_MS);
            startHeartbeat();
            return { ok: true, path: p.label || p.id, product: res.product || '' };
          } catch (_) {
            await closePort();
          }
        }
      } finally {
        autoConnecting = false;
      }

      await closePort();
      return { ok: false, reason: 'not-found' };
    }

    // 需要用户手势的平台（Web Serial）：弹出系统设备选择框并连接
    async function choosePort() {
      if (typeof transport.requestPort !== 'function') return { ok: false, reason: 'unsupported' };
      const picked = await transport.requestPort(); // { id, label }，取消则为 null
      if (!picked) return { ok: false, reason: 'canceled' };

      autoConnecting = true;
      try {
        const res = await probe(picked.id, Date.now() + AUTO_PING_MS);
        startHeartbeat();
        return { ok: true, path: picked.label || picked.id, product: res.product || '' };
      } catch (_) {
        await closePort();
        return { ok: false, reason: 'not-target' };
      } finally {
        autoConnecting = false;
      }
    }

    return {
      requiresUserGesture: !!transport.requiresUserGesture,
      autoconnect,
      choosePort,
      request,
      onStatus: (cb) => listeners.status.push(cb),
      onLine: (cb) => listeners.line.push(cb),
      onTx: (cb) => listeners.tx.push(cb),
      onClosed: (cb) => listeners.closed.push(cb),
      onError: (cb) => listeners.error.push(cb),
    };
  }

  window.MidiCore = { createClient };
})();
