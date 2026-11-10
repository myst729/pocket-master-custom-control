const KEY_COUNT = 8;
const TOGGLE_VALUE = 255; // 与固件约定的“切换”标记：每次触发在 0 / 127 之间翻转
const FIXED_CHANNEL = 1; // UI 不展示通道，统一使用通道 1
const HEART_BEAT_MS = 1000; // 心跳间隔
const NOT_FOUND_MS = 10000; // 超过这个时间还没找到就提示“未找到设备”（但继续重试）
const LOG_SWITCH_DEFAULT = false; // 日志默认开关

const onOff = (off = '关', on = '开') => [
  { value: 0, label: off },
  { value: 127, label: on },
  { value: TOGGLE_VALUE, label: '切换' },
];

// 没有 values/range 的 CC 表示“取值无意义”（范围内任意值效果相同），UI 不展示取值控件，统一发送 0
const CC_TABLE = [
  {
    cc: 1,
    name: '预设选择',
    values: [
      ...Array.from({ length: 50 }, (_, i) => ({ value: i + 1,  label: `P${String(i + 1).padStart(2, '0')}` })),
      ...Array.from({ length: 50 }, (_, i) => ({ value: i + 51, label: `F${String(i + 1).padStart(2, '0')}` })),
    ],
  },
  { cc: 6,  name: '总音量', range: [0, 100] },
  { cc: 7,  name: '预设音量', range: [0, 100] },
  { cc: 22, name: '预设组 -' },
  { cc: 23, name: '预设组 +' },
  { cc: 24, name: '预设 -' },
  { cc: 25, name: '预设 +' },
  { cc: 43, name: 'NR 模块开关', values: onOff() },
  { cc: 44, name: 'FX1 模块开关', values: onOff() },
  { cc: 45, name: 'DRV 模块开关', values: onOff() },
  { cc: 46, name: 'AMP 模块开关', values: onOff() },
  { cc: 47, name: 'IR 模块开关', values: onOff() },
  { cc: 48, name: 'EQ 模块开关', values: onOff() },
  { cc: 49, name: 'FX2 模块开关', values: onOff() },
  { cc: 50, name: 'DLY 模块开关', values: onOff() },
  { cc: 51, name: 'RVB 模块开关', values: onOff() },
  { cc: 58, name: '调音表开关', values: onOff() },
  { cc: 59, name: '乐句循环器开关', values: onOff() },
  { cc: 60, name: '乐句循环器录制' },
  { cc: 62, name: '乐句循环器播放 / 停止', values: onOff('停止', '播放') },
  { cc: 64, name: '清空乐句' },
  { cc: 65, name: '乐句循环器录制音量', range: [0, 100] },
  { cc: 66, name: '乐句循环器播放音量', range: [0, 100] },
  { cc: 67, name: '乐句循环器位置', values: onOff('后置', '前置') },
  { cc: 92, name: '鼓机界面开关', values: onOff() },
  { cc: 93, name: '鼓机播放 / 停止', values: onOff('停止', '播放') },
  {
    cc: 94,
    name: '鼓机节奏型',
    values: ['1/4', '2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '6/8', '7/8', '9/8'].map((label, i) => ({ value: i, label })),
  },
  { cc: 95, name: '鼓机音量', range: [0, 100] },
];

const CC_BY_NUMBER = new Map(CC_TABLE.map((item) => [item.cc, item]));

// 每个 CC 的取值控件类型：'select' 下拉 / 'range' 滑块 / 'none' 无控件（固定发 0）
function ccControlKind(cc) {
  const item = CC_BY_NUMBER.get(cc);
  if (!item) return 'none';
  if (Array.isArray(item.range)) return 'range';
  if (Array.isArray(item.values)) return 'select';
  return 'none';
}

// 传输层按运行环境自动挑选：Electron 走主进程 serialport，浏览器走 Web Serial。
// 不支持（如非桌面 Chrome/Edge、非 localhost/HTTPS）时为 null。
const transport = window.createTransport();
const api = transport ? window.MidiCore.createClient(transport) : null;

const el = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  portBtn: document.getElementById('portBtn'),
  pingBtn: document.getElementById('pingBtn'),
  getBtn: document.getElementById('getBtn'),
  resetBtn: document.getElementById('resetBtn'),
  saveBtn: document.getElementById('saveBtn'),
  dirtyHint: document.getElementById('dirtyHint'),
  keyBody: document.getElementById('keyBody'),
  log: document.getElementById('log'),
  logCard: document.getElementById('logCard'),
  hideLogBtn: document.getElementById('hideLogBtn'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modalTitle'),
  modalText: document.getElementById('modalText'),
  modalOk: document.getElementById('modalOk'),
  modalCancel: document.getElementById('modalCancel'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let busy = false;
let connecting = false; // 是否正在跑“查找设备”循环
let connected = false; // 当前是否已连上设备
let deviceKeys = []; // 设备当前配置；未连接时为空
let searchStartedAt = 0; // 本轮查找的起始时间
const rows = [];

// ---------------- 模态确认框 ----------------

function confirmModal(text, { title = '确认操作', okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    el.modalTitle.textContent = title;
    el.modalText.textContent = text;
    el.modalOk.textContent = okText;
    el.modalOk.className = danger ? 'danger' : 'primary';
    el.modal.hidden = false;
    el.modalOk.focus();

    const done = (value) => {
      el.modal.hidden = true;
      el.modalOk.removeEventListener('click', onOk);
      el.modalCancel.removeEventListener('click', onCancel);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);

    el.modalOk.addEventListener('click', onOk);
    el.modalCancel.addEventListener('click', onCancel);
  });
}

// ---------------- 日志 ----------------

// 日志开关：在 DevTools 控制台执行 `logEnabled = false` 隐藏日志界面并停止记录，`= true` 恢复
let logOn = LOG_SWITCH_DEFAULT;
Object.defineProperty(window, 'logEnabled', {
  get: () => logOn,
  set: (value) => {
    logOn = !!value;
    el.logCard.hidden = !logOn;
  },
});

// 初始就按开关值决定是否显示日志卡片
el.logCard.hidden = !logOn;

function log(text, cls) {
  // if (!logOn) return;
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ' ' + cls : '');
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `[${ts}] ${text}`;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}

if (api) {
  api.onTx((line) => log('TX ' + line, 'tx'));
  api.onLine((line) => {
    const isProtocol = line.startsWith('{') && line.includes('"ok"');
    log('RX ' + line, isProtocol ? 'rx' : 'info');
  });
  api.onError((msg) => log('串口错误: ' + msg, 'err'));
  api.onClosed(() => {
    if (connecting) return; // 查找循环里的探测会反复开关端口，忽略这些中间事件
    log('设备已断开，正在重新查找设备…', 'err');
    setDisconnected();
    connectLoop();
  });
  api.onStatus((s) => {
    if (!connecting || Date.now() - searchStartedAt >= NOT_FOUND_MS) return;
    if (s && s.phase === 'trying') {
      el.statusText.textContent = `正在尝试连接…`;
    }
  });
}

// ---------------- 下拉框构建 ----------------

function ensureOption(select, value, labelBuilder) {
  const found = Array.from(select.options).find((o) => Number(o.value) === value);
  if (found) return;
  const opt = document.createElement('option');
  opt.value = String(value);
  opt.textContent = labelBuilder(value);
  select.appendChild(opt);
}

function ccLabel(cc) {
  const item = CC_BY_NUMBER.get(cc);
  return item ? `${cc} · ${item.name}` : `${cc} · 未在对照表中`;
}

function fillValueSelect(select, cc, keepValue) {
  const item = CC_BY_NUMBER.get(cc);
  select.replaceChildren();
  if (!item || !Array.isArray(item.values)) return; // 取值无意义的 CC 不填选项
  for (const v of item.values) {
    const opt = document.createElement('option');
    opt.value = String(v.value);
    opt.textContent = v.label;
    select.appendChild(opt);
  }
  if (keepValue !== undefined && keepValue !== null) {
    ensureOption(select, keepValue, (v) => `${v} · 表中无此项`);
    select.value = String(keepValue);
  }
  if (select.selectedIndex < 0 && select.options.length > 0) {
    select.selectedIndex = 0;
  }
}

// 滑块：设置范围并把值夹到范围内
function fillRangeInput(input, cc, value) {
  const item = CC_BY_NUMBER.get(cc);
  if (!item || !Array.isArray(item.range)) return;
  const [min, max] = item.range;
  input.min = String(min);
  input.max = String(max);
  const v = value === undefined || value === null ? min : value;
  input.value = String(Math.min(max, Math.max(min, v)));
}

// 按 CC 的取值控件类型切换 下拉 / 滑块 / 占位符
function syncValueControl(row, cc) {
  const kind = ccControlKind(cc);
  row.valueSelect.hidden = kind !== 'select';
  row.valueRangeWrap.hidden = kind !== 'range';
  row.valueNA.hidden = kind !== 'none';
  if (kind === 'range') row.valueRangeNum.textContent = row.valueRange.value;
}

function buildRows() {
  el.keyBody.replaceChildren();
  for (let i = 0; i < KEY_COUNT; i++) {
    const tr = document.createElement('tr');

    const tdKey = document.createElement('td');
    tdKey.textContent = 'KEY' + (i + 1);
    tr.appendChild(tdKey);

    const tdCc = document.createElement('td');
    const ccSelect = document.createElement('select');
    ccSelect.className = 'cc-select';
    for (const item of CC_TABLE) {
      const opt = document.createElement('option');
      opt.value = String(item.cc);
      opt.textContent = `[${item.cc}] ${item.name}`;
      ccSelect.appendChild(opt);
    }
    tdCc.appendChild(ccSelect);
    tr.appendChild(tdCc);

    const tdValue = document.createElement('td');
    const valueSelect = document.createElement('select');
    const valueRangeWrap = document.createElement('span');
    valueRangeWrap.className = 'range-wrap';
    const valueRange = document.createElement('input');
    valueRange.type = 'range';
    const valueRangeNum = document.createElement('span');
    valueRangeNum.className = 'range-num';
    valueRangeWrap.append(valueRange, valueRangeNum);
    const valueNA = document.createElement('span');
    valueNA.className = 'na';
    valueNA.textContent = ''; //'—';
    tdValue.append(valueSelect, valueRangeWrap, valueNA);
    tr.appendChild(tdValue);

    ccSelect.addEventListener('change', () => {
      const cc = Number(ccSelect.value);
      fillValueSelect(valueSelect, cc, undefined);
      fillRangeInput(valueRange, cc, undefined);
      syncValueControl({ valueSelect, valueRangeWrap, valueRange, valueRangeNum, valueNA }, cc);
      refreshDirty();
    });
    valueSelect.addEventListener('change', refreshDirty);
    valueRange.addEventListener('input', () => {
      valueRangeNum.textContent = valueRange.value;
      refreshDirty();
    });

    el.keyBody.appendChild(tr);
    rows.push({ cc: ccSelect, valueSelect, valueRangeWrap, valueRange, valueRangeNum, valueNA });
  }
}

function setRow(i, key) {
  const row = rows[i];
  ensureOption(row.cc, key.cc, ccLabel);
  row.cc.value = String(key.cc);
  fillValueSelect(row.valueSelect, key.cc, key.value);
  fillRangeInput(row.valueRange, key.cc, key.value);
  syncValueControl(row, key.cc);
}

function readRow(i) {
  const row = rows[i];
  const cc = Number(row.cc.value);
  const kind = ccControlKind(cc);
  let value = 0;
  if (kind === 'select') value = Number(row.valueSelect.value);
  else if (kind === 'range') value = Number(row.valueRange.value);
  return { cc, value, channel: FIXED_CHANNEL };
}

function isRowValid(row) {
  return (
    Number.isInteger(row.cc) &&
    row.cc >= 0 &&
    row.cc <= 127 &&
    Number.isInteger(row.value) &&
    row.value >= 0 &&
    (row.value <= 127 || row.value === TOGGLE_VALUE)
  );
}

function isRowChanged(i) {
  const dev = deviceKeys[i];
  if (!dev) return false; // 未读到设备配置前不算修改
  const row = readRow(i);
  return row.cc !== dev.cc || row.value !== dev.value;
}

function refreshDirty() {
  let count = 0;
  for (let i = 0; i < KEY_COUNT; i++) {
    const changed = connected && isRowChanged(i);
    if (changed) count++;
    el.keyBody.children[i].classList.toggle('changed', changed);
  }
  el.dirtyHint.textContent = count > 0 ? `${count} 个按键有未保存修改` : '';
  return count;
}

function applyKeysToInputs(keys) {
  for (let i = 0; i < KEY_COUNT && i < keys.length; i++) {
    setRow(i, keys[i]);
  }
  refreshDirty();
}

function storeDeviceKeys(keys) {
  deviceKeys = keys.map((k) => ({ cc: k.cc, value: k.value, channel: k.channel }));
}

// ---------------- 连接 ----------------

function setStatus(kind, text) {
  el.statusDot.className = 'dot' + (kind ? ' ' + kind : '');
  el.statusText.textContent = text;
}

// 未连接时不展示任何配置：清空下拉、隐藏取值控件
function blankRows() {
  for (const row of rows) {
    row.cc.selectedIndex = -1;
    row.valueSelect.replaceChildren();
    row.valueSelect.hidden = true;
    row.valueRangeWrap.hidden = true;
    row.valueNA.hidden = true;
  }
}

function setConfigEnabled(value) {
  for (const b of [el.pingBtn, el.getBtn, el.resetBtn, el.saveBtn]) b.disabled = !value;
  for (const row of rows) {
    row.cc.disabled = !value;
    row.valueSelect.disabled = !value;
    row.valueRange.disabled = !value;
  }
}

// 未连接状态：顶部与表格都禁用，表格内容清空
function setDisconnected() {
  connected = false;
  deviceKeys = [];
  setStatus('busy', '正在查找设备…');
  setConfigEnabled(false);
  blankRows();
  refreshDirty();
}

// 持续查找设备：每 1 秒扫描一次串口，连上即停止；断开后由 onClosed 重新启动。
async function connectLoop() {
  if (connecting || !api) return;
  connecting = true;
  searchStartedAt = Date.now();
  setConfigEnabled(false);
  try {
    while (!connected) {
      if (Date.now() - searchStartedAt < NOT_FOUND_MS) {
        setStatus('busy', '正在查找设备…');
      } else if (api.requiresUserGesture) {
        // Web Serial 只能自动连“已授权过”的设备，首次需要用户手动选择
        setStatus('err', '未找到设备，请点击右上角“选择设备”');
      } else {
        setStatus('err', '未找到设备');
      }

      let res = null;
      try {
        res = await api.autoconnect();
      } catch (e) {
        log('查找设备异常: ' + e.message, 'err');
      }

      if (res && res.ok) {
        connected = true;
        // setStatus('on', `已连接 ${res.path}`);
        setStatus('on', '设备已连接');
        setConfigEnabled(true);
        log(`已连接 ${res.path} · 已校验设备标识 ${res.product}`);
        await doGet(true);
        break;
      }

      await sleep(HEART_BEAT_MS);
    }
  } finally {
    connecting = false;
  }
}

// Web 版首次需要用户手动授权：必须由点击事件直接触发（浏览器要求用户手势）
async function connectByUserGesture() {
  if (!api || connected) return;
  setStatus('busy', '等待选择设备…');
  try {
    const res = await api.choosePort();
    if (res && res.ok) {
      connected = true;
      setStatus('on', '设备已连接');
      setConfigEnabled(true);
      log(`已连接 ${res.path} · 已校验设备标识 ${res.product}`);
      await doGet(true);
      connectLoop(); // 若查找循环已退出，这里重新启动（connected=true 会立刻结束）
      return;
    }
    if (res && res.reason === 'canceled') {
      setStatus('err', '已取消选择');
      return;
    }
    log('所选设备不是本项目的固件', 'err');
    setStatus('err', '所选设备不匹配');
  } catch (e) {
    log('选择设备失败: ' + e.message, 'err');
    setStatus('err', '选择设备失败');
  }
}

// ---------------- 命令 ----------------

async function run(label, fn) {
  if (busy) {
    log('上一条命令还在处理中，请稍候', 'err');
    return null;
  }
  busy = true;
  try {
    return await fn();
  } catch (e) {
    log(`${label} 失败: ${e.message}`, 'err');
    return null;
  } finally {
    busy = false;
  }
}

async function doPing(quiet) {
  return run('ping', async () => {
    const res = await api.request({ cmd: 'ping' });
    if (res && res.ok) {
      if (!quiet) log(`设备在线: ${res.product}`);
      return res;
    }
    log('ping 无有效响应', 'err');
    return null;
  });
}

async function doGet(quiet) {
  return run('get', async () => {
    const res = await api.request({ cmd: 'get' });
    if (res && res.ok && Array.isArray(res.keys)) {
      storeDeviceKeys(res.keys);
      applyKeysToInputs(res.keys);
      if (!quiet) log('已读取当前配置');
      return res;
    }
    log('get 失败: ' + (res && res.error ? res.error : '无有效响应'), 'err');
    return null;
  });
}

async function doReset() {
  const ok = await confirmModal('确定恢复默认配置？该操作会覆盖设备内所有按键设置。', {
    title: '恢复默认',
    okText: '恢复默认',
    danger: true,
  });
  if (!ok) return;
  return run('reset', async () => {
    const res = await api.request({ cmd: 'reset' });
    if (res && res.ok && Array.isArray(res.keys)) {
      storeDeviceKeys(res.keys);
      applyKeysToInputs(res.keys);
      log('已恢复默认配置（重启设备后生效）');
      return res;
    }
    log('reset 失败: ' + (res && res.error ? res.error : '无有效响应'), 'err');
    return null;
  });
}

async function doSave() {
  const changed = [];
  for (let i = 0; i < KEY_COUNT; i++) {
    if (!isRowChanged(i)) continue;
    const row = readRow(i);
    if (!isRowValid(row)) {
      log(`KEY${i + 1} 取值越界，未发送（CC/值 0–127）`, 'err');
      return;
    }
    changed.push({ key: i + 1, ...row });
  }

  if (changed.length === 0) {
    log('没有需要保存的修改');
    return;
  }

  return run('set', async () => {
    for (const item of changed) {
      const res = await api.request({ cmd: 'set', ...item });
      if (!res || !res.ok) {
        log(`KEY${item.key} 保存失败: ${res && res.error ? res.error : '无有效响应'}`, 'err');
        return null;
      }
      if (Array.isArray(res.keys)) {
        storeDeviceKeys(res.keys);
      }
    }
    applyKeysToInputs(deviceKeys);
    log(`已保存 ${changed.length} 个按键，重启设备后生效`);
    return true;
  });
}

// ---------------- 事件绑定 ----------------

el.pingBtn.addEventListener('click', () => doPing(false));
el.getBtn.addEventListener('click', () => doGet(false));
el.resetBtn.addEventListener('click', doReset);
el.saveBtn.addEventListener('click', doSave);
el.clearLogBtn.addEventListener('click', () => el.log.replaceChildren());
el.hideLogBtn.addEventListener('click', () => window.logEnabled = false);
el.portBtn.addEventListener('click', connectByUserGesture);

buildRows();

if (!api) {
  // 环境不支持（非桌面版 Chrome / Edge，或非 HTTPS / localhost）
  setDisconnected();
  setStatus('err', '当前环境不支持串口，请用桌面版 Chrome / Edge 打开');
  log('未检测到可用串口通道：Electron 需要 window.nativeSerial，浏览器需要 Web Serial', 'err');
} else {
  // Web Serial 只能自动连“已授权过”的设备，首次需要用户手动选择
  el.portBtn.hidden = !api.requiresUserGesture;
  setDisconnected();
  log('就绪：正在查找设备');
  connectLoop();
}
