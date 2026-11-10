// 与固件约定的串口协议：115200 8N1，每行一个 JSON，以 '\n' 结束。
// 本文件与平台无关（浏览器 / Node 均可加载），只做“字节流 -> 行 -> 响应对象”的转换。
// 包一层 IIFE，避免与其他以 <script> 方式共存的模块发生顶层名字冲突。
(function () {
  // 固件 ping 响应里的 product，用来排除其他 ESP32 项目
  const PRODUCT_ID = 'pocket-master-custom-control';

  // 增量分行器：数据块可能在任何位置被切开，这里缓存不完整的尾巴
  function createLineReader() {
    let buf = '';
    return {
      push(chunk) {
        buf += chunk;
        const lines = [];
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '').trim();
          buf = buf.slice(idx + 1);
          if (line) lines.push(line);
        }
        return lines;
      },
      reset() {
        buf = '';
      },
    };
  }

  // 只接受“以 { 开头且含 "ok"”的行作为协议响应，其余是设备的纯文本日志
  function parseResponseLine(line) {
    if (!line.startsWith('{') || !line.includes('"ok"')) return null;
    try {
      return JSON.parse(line);
    } catch (_) {
      return null;
    }
  }

  // 是否为本站固件：ok 为真且设备标识吻合
  function isTargetDevice(res) {
    return !!res && res.ok === true && res.product === PRODUCT_ID;
  }

  window.MidiProtocol = { PRODUCT_ID, createLineReader, parseResponseLine, isTargetDevice };
})();

