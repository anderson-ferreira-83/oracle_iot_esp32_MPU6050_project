const CONFIG = {
  // Endpoints da API FastAPI
  API_ENDPOINT: '../api/get_data?mode=latest',
  HISTORY_ENDPOINT: '../api/get_data',
  HISTORY_SECONDS: 60,      // Janela de tempo inicial para o histórico (em segundos)
  REALTIME_WINDOW_SECONDS: 5, // Janela para atualizações em tempo real
  UPDATE_INTERVAL: 200,     // pull a cada 200ms (5Hz) - alinhado com taxa do ESP32
  MAX_POINTS: 7200,
  TIME_RANGE: 'all',
  OFFLINE_AFTER_MS: 10000,  // v4.1: Reduzido para 10s
  GAP_THRESHOLD_MS: 2000,   // Quebra a linha quando houver buracos maiores que 2s
};

const DEVICE_ID_ALIASES = {
  ESP32_FAN_V7: 'ESP32_MPU6050_ORACLE',
  ESP32_MPU6050_XAMPP: 'ESP32_MPU6050_ORACLE',
};
const DEVICE_ID_STORAGE_KEY = 'iot_fan_control_device_id';
const DEFAULT_DEVICE_ID = 'ESP32_MPU6050_ORACLE';

function normalizeDeviceId(deviceId) {
  const clean = String(deviceId || '').trim();
  if (!clean) return '';
  return DEVICE_ID_ALIASES[clean] || clean;
}

const DEVICE_ID = (() => {
  const raw = new URLSearchParams(window.location.search).get('device_id');
  if (raw && raw.trim()) return normalizeDeviceId(raw.trim());
  try {
    const cached = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (cached && cached.trim()) return normalizeDeviceId(cached.trim());
  } catch (e) {
    // ignore localStorage access failures
  }
  return DEFAULT_DEVICE_ID;
})();

try {
  if (DEVICE_ID) localStorage.setItem(DEVICE_ID_STORAGE_KEY, DEVICE_ID);
} catch (e) {
  // ignore localStorage access failures
}

function withDeviceId(url) {
  if (!DEVICE_ID) return url;
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.set('device_id', DEVICE_ID);
  return parsed.toString();
}

if (DEVICE_ID) {
  const controlLink = document.querySelector('a.nav-link[href="control.html"]');
  if (controlLink) {
    controlLink.href = `control.html?device_id=${encodeURIComponent(DEVICE_ID)}`;
  }
}

const G_TO_MS2 = 1; // Alterado para 1 para exibir em 'g' (igual ao banco de dados)

// =============================================================================
// CLASS HELPERS (uses ClassLabels from classifier.js)
// =============================================================================
function _classColor(label) {
  return (typeof ClassLabels !== 'undefined' && ClassLabels.COLORS[label]) || '#888';
}
function _classShort(label) {
  return (typeof ClassLabels !== 'undefined' && ClassLabels.SHORT[label]) || label;
}
function _classDescription(label, confPct) {
  const desc = (typeof ClassLabels !== 'undefined' && ClassLabels.DESCRIPTIONS[label]) || label;
  return `${desc} (${confPct}% confiança)`;
}
function _getModelLabels() {
  return window.fanClassifier?.classifier?.model?.labels
    || (typeof ClassLabels !== 'undefined' ? ClassLabels.ORDER : ['LOW','MEDIUM','HIGH']);
}
function _getAdjacentPairs(labels) {
  const pairs = [];
  for (let i = 0; i < labels.length - 1; i++) {
    pairs.push([labels[i], labels[i + 1]]);
  }
  return pairs;
}
function _ensureProbItems(container, labels, suffix) {
  const existingId = `mlProb_${labels[0]}_${suffix}`;
  if (document.getElementById(existingId)) return;
  container.innerHTML = '';
  for (const lbl of labels) {
    const item = document.createElement('div');
    item.className = 'ml-prob-item';
    item.innerHTML = `<div class="ml-prob-label" style="color:${_classColor(lbl)};">${_classShort(lbl)}</div>
      <div class="ml-prob-value" id="mlProb_${lbl}_${suffix}">--</div>`;
    container.appendChild(item);
  }
}
// Baseline do notebook 01_EDA (media e desvio padrao)
const EDA_BASELINES = {
  accel: {
    x: { mean: 0.292149, std: 0.135707 },
    y: { mean: -0.054381, std: 0.142231 },
    z: { mean: -1.080378, std: 0.03539 },
  },
  gyro: {
    x: { mean: -0.800927, std: 4.581188 },
    y: { mean: 0.564558, std: 2.825205 },
    z: { mean: 0.734018, std: 17.040692 },
  },
};

// Per-class EDA baselines (loaded from config/eda_baselines_per_class.json)
let EDA_PER_CLASS_BASELINES = null;
// Per-class baselines derived from the latest Soak session used in Online Learning (stored inside adapted models).
let ADAPTED_PER_CLASS_BASELINES = null;
let ADAPTED_PER_CLASS_BASELINES_META = null;
let refBaselinesSource = 'training'; // 'training' | 'adapted'

function setAdaptedPerClassBaselinesFromModel(modelObj) {
  const meta = modelObj?._ol_reference_baselines;
  const classes = meta?.classes;
  if (classes && typeof classes === 'object') {
    ADAPTED_PER_CLASS_BASELINES = classes;
    ADAPTED_PER_CLASS_BASELINES_META = meta;
    refBaselinesSource = 'adapted';
    return true;
  }
  return false;
}

function clearAdaptedPerClassBaselines() {
  ADAPTED_PER_CLASS_BASELINES = null;
  ADAPTED_PER_CLASS_BASELINES_META = null;
  refBaselinesSource = 'training';
}

function getActivePerClassBaselines() {
  if (refBaselinesSource === 'adapted' && ADAPTED_PER_CLASS_BASELINES) {
    return ADAPTED_PER_CLASS_BASELINES;
  }
  return EDA_PER_CLASS_BASELINES;
}

function getActiveBaselinesLabel() {
  return (refBaselinesSource === 'adapted' && ADAPTED_PER_CLASS_BASELINES)
    ? 'Referência (Adaptado)'
    : 'Referência (Treino)';
}

async function loadPerClassBaselines() {
  try {
    const resp = await fetch('../config/eda_baselines_per_class.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    EDA_PER_CLASS_BASELINES = data.classes;
    console.log('[Dashboard] EDA per-class baselines loaded:', Object.keys(EDA_PER_CLASS_BASELINES));
    return true;
  } catch (e) {
    console.warn('[Dashboard] Failed to load EDA baselines:', e);
    return false;
  }
}

// Cache local para armazenar os dados recebidos e evitar requisições repetidas
const cache = [];
const alerts = [];
let lastCollectionRateWarning = null;
let lastCollectionRateWarningAt = 0;
let lastDataTs = null;
let mlDataOnline = null;
let mlErrorState = null;
let latestFetchInFlight = false;
let lastMLFeedTs = null;
let lastMLFeedCounter = null;
let lastFetchAt = null;
let lastSeenCounter = null;
let lastSampleTs = null;
let lastServerConfig = {};
let lastPayload = null;
// Variáveis de Controle de Playback (Pausa/Navegação)
let isPaused = false;
let pauseSnapshot = null;
let viewOffsetMs = 0;
let dataFetchIntervalId = null;
let currentDashboardRateHz = 1000 / CONFIG.UPDATE_INTERVAL;

function formatTimeLabel(ts) {
  if (!Number.isFinite(ts)) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('pt-BR');
}

function formatRelativeTimeLabel(ts) {
  const now = isPaused && pauseSnapshot ? pauseSnapshot : getNow();
  const diff = (ts - now) / 1000;
  return diff.toFixed(1) + 's';
}

function formatDateTimeLabel(ts) {
  if (!Number.isFinite(ts)) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('pt-BR');
}

function getNow() {
  return Date.now();
}

// Converte timestamps variados (strings SQL, segundos, ms) para milissegundos numéricos
function normalizeTimestampMs(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    // Tenta interpretar string de data SQL (ex: "2026-01-29 14:30:00")
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return date.getTime();
    }
    return fallback;
  }
  if (num >= 1e12) {
    return Math.floor(num);
  }
  if (num >= 1e9) {
    return Math.floor(num * 1000);
  }
  return Math.floor(num * 1000);
}

// Padroniza o objeto de dados recebido da API
function normalizePayload(payload) {
  const rawTs = payload.timestamp_ms ?? payload.timestamp ?? payload.timestamp_s ?? payload.ts ?? payload.created_at;
  const ts = normalizeTimestampMs(rawTs, getNow());
  const hasRealTimestamp = normalizeTimestampMs(rawTs, null) !== null;
  return {
    device_id: normalizeDeviceId(payload.device_id || ''),
    ts,
    hasRealTimestamp,
    counter: payload.contador != null ? Number(payload.contador) : (payload.counter != null ? Number(payload.counter) : null),
    sample_rate: payload.sample_rate ?? payload.sr ?? null,
    temperature: Number(payload.temperature ?? payload.t ?? 0),
    vibration: Number(payload.vibration ?? payload.v ?? 0),
    vibration_dps: payload.vibration_dps != null ? Number(payload.vibration_dps) : null,
    accel_x_g: Number(payload.accel_x_g ?? payload.ax ?? 0),
    accel_y_g: Number(payload.accel_y_g ?? payload.ay ?? 0),
    accel_z_g: Number(payload.accel_z_g ?? payload.az ?? 0),
    gyro_x_dps: Number(payload.gyro_x_dps ?? payload.gx ?? 0),
    gyro_y_dps: Number(payload.gyro_y_dps ?? payload.gy ?? 0),
    gyro_z_dps: Number(payload.gyro_z_dps ?? payload.gz ?? 0),
    mode: payload.mode || payload.sample_mode || payload.data_mode || payload.stream_mode || '',
    feature_window: payload.feature_window_samples != null
      ? Number(payload.feature_window_samples)
      : (payload.feature_window != null ? Number(payload.feature_window) : null),
    accel_x_g_std: payload.accel_x_g_std != null ? Number(payload.accel_x_g_std) : null,
    accel_x_g_range: payload.accel_x_g_range != null ? Number(payload.accel_x_g_range) : null,
    accel_x_g_rms: payload.accel_x_g_rms != null ? Number(payload.accel_x_g_rms) : null,
    gyro_y_dps_std: payload.gyro_y_dps_std != null ? Number(payload.gyro_y_dps_std) : null,
    gyro_y_dps_rms: payload.gyro_y_dps_rms != null ? Number(payload.gyro_y_dps_rms) : null,
    gyro_y_dps_range: payload.gyro_y_dps_range != null ? Number(payload.gyro_y_dps_range) : null,
    collection_id: payload.collection_id || '',
    phase_marker: payload.phase_marker === true || payload.phase_marker === 'true',
    fan_state: payload.fan_state || 'UNKNOWN',
    severity: payload.severity || 'NONE',
    message: payload.message || 'Sistema normal',
  };
}

// Adiciona dados ao cache, evitando duplicatas
function pushCache(item) {
  const last = cache[cache.length - 1];
  if (last) {
    const hasCounter = Number.isFinite(last.counter) && Number.isFinite(item.counter);
    if (hasCounter && last.counter === item.counter) {
      return;
    }
    if (!hasCounter && last.ts === item.ts) {
      return;
    }
  }
  if (last && last.ts === item.ts && !Number.isFinite(item.counter)) {
    return;
  }
  cache.push(item);
  if (cache.length > CONFIG.MAX_POINTS) {
    cache.shift();
  }
}

// Calcula o início e fim do eixo X do gráfico (Janela Deslizante)
function getWindowLimits() {
  const anchor = isPaused ? pauseSnapshot : getNow();
  const end = anchor - viewOffsetMs;

  if (CONFIG.TIME_RANGE === 'all') {
    return { start: null, end };
  }

  let delta = 0;
  if (CONFIG.TIME_RANGE === '30s') delta = 30 * 1000;
  if (CONFIG.TIME_RANGE === '1m') delta = 60 * 1000;
  if (CONFIG.TIME_RANGE === '5m') delta = 5 * 60 * 1000;
  if (CONFIG.TIME_RANGE === '10m') delta = 10 * 60 * 1000;
  if (CONFIG.TIME_RANGE === '1h') delta = 60 * 60 * 1000;
  if (CONFIG.TIME_RANGE === '6h') delta = 6 * 60 * 60 * 1000;

  return { start: end - delta, end };
}

// Remove dados inválidos ou muito futuros do array de plotagem
function sanitizeSeries(data) {
  const now = getNow();
  const maxFuture = now + 5 * 60 * 1000; // tolerância 5 min
  const sorted = data
    .filter(item => Number.isFinite(item.ts) && item.ts > 0 && item.ts <= maxFuture)
    .slice()
    .sort((a, b) => a.ts - b.ts);

  const deduped = [];
  let lastTs = null;
  for (const item of sorted) {
    if (item.ts === lastTs) continue;
    deduped.push(item);
    lastTs = item.ts;
  }
  return deduped;
}

// Atualiza o badge de status (Online/Offline)
function updateStatus(isOnline) {
  const badge = document.getElementById('statusBadge');
  if (isOnline) {
    badge.className = 'status-badge status-online';
    badge.innerHTML = '<span class="pulse"></span>Online';
  } else {
    badge.className = 'status-badge status-offline';
    badge.innerHTML = '<span class="pulse"></span>Offline';
  }
  setMLDataOnline(isOnline);
}

function isFresh() {
  if (lastSampleTs == null) return false;
  const now = getNow();
  return now - lastSampleTs <= CONFIG.OFFLINE_AFTER_MS;
}

// Atualiza os valores numéricos nos cartões (Temperatura, Vibração, etc.)
function updateCards(latest) {
  const temp = latest.temperature;
  const vib = latest.vibration_dps != null ? latest.vibration_dps : latest.vibration;
  const accelX = latest.accel_x_g * G_TO_MS2;
  const accelY = latest.accel_y_g * G_TO_MS2;
  const accelZ = latest.accel_z_g * G_TO_MS2;
  const accelMag = Math.sqrt(
    accelX ** 2 +
    accelY ** 2 +
    accelZ ** 2
  );
  const gyroMag = Math.sqrt(
    latest.gyro_x_dps ** 2 +
    latest.gyro_y_dps ** 2 +
    latest.gyro_z_dps ** 2
  );

  document.getElementById('tempValue').textContent = temp.toFixed(1);
  const accelAxisXEl = document.getElementById('accelAxisX');
  if (accelAxisXEl) {
    accelAxisXEl.textContent = `Mag=${accelMag.toFixed(2)} g`;
    if (document.getElementById('accelAxisY')) document.getElementById('accelAxisY').textContent = '';
    if (document.getElementById('accelAxisZ')) document.getElementById('accelAxisZ').textContent = '';
  }

  const gyroAxisXEl = document.getElementById('gyroAxisX');
  if (gyroAxisXEl) {
    gyroAxisXEl.textContent = `Mag=${gyroMag.toFixed(2)} dps`;
    if (document.getElementById('gyroAxisY')) document.getElementById('gyroAxisY').textContent = '';
    if (document.getElementById('gyroAxisZ')) document.getElementById('gyroAxisZ').textContent = '';
  }

  document.getElementById('tempProgress').style.width = Math.min(100, (temp / 50) * 100) + '%';
  document.getElementById('accelMagProgress').style.width = Math.min(100, (accelMag / 40) * 100) + '%';
  document.getElementById('gyroMagProgress').style.width = Math.min(100, (gyroMag / 500) * 100) + '%';

  // Update payload summary (column layout)
  const timestampEl = document.getElementById('lastPayloadTimestamp');
  const tempEl = document.getElementById('lastPayloadTemp');
  const vibEl = document.getElementById('lastPayloadVib');
  if (timestampEl) timestampEl.textContent = new Date(latest.ts).toLocaleString('pt-BR');
  if (tempEl) tempEl.textContent = `T=${temp.toFixed(1)}°C`;
  if (vibEl) vibEl.textContent = `Vib=${vib.toFixed(2)} dps`;

  // Fallback for old single-line element
  const summaryEl = document.getElementById('lastPayloadSummary');
  if (summaryEl) {
    summaryEl.textContent = `${payloadTime} | T=${temp.toFixed(1)}°C | Vib=${vib.toFixed(2)} dps`;
  }

  // Update acceleration axes (column layout)
  const axEl = document.getElementById('lastPayloadAX');
  const ayEl = document.getElementById('lastPayloadAY');
  const azEl = document.getElementById('lastPayloadAZ');
  if (axEl) axEl.textContent = `AX=${accelX.toFixed(2)} g`;
  if (ayEl) ayEl.textContent = `AY=${accelY.toFixed(2)} g`;
  if (azEl) azEl.textContent = `AZ=${accelZ.toFixed(2)} g`;

  // Fallback for old single-line element
  const accelEl = document.getElementById('lastPayloadAccel');
  if (accelEl) {
    accelEl.textContent = `AX=${accelX.toFixed(2)} g | AY=${accelY.toFixed(2)} g | AZ=${accelZ.toFixed(2)} g`;
  }

  // Update gyroscope axes (column layout)
  const gxEl = document.getElementById('lastPayloadGX');
  const gyEl = document.getElementById('lastPayloadGY');
  const gzEl = document.getElementById('lastPayloadGZ');
  if (gxEl) gxEl.textContent = `GX=${latest.gyro_x_dps.toFixed(3)} dps`;
  if (gyEl) gyEl.textContent = `GY=${latest.gyro_y_dps.toFixed(3)} dps`;
  if (gzEl) gzEl.textContent = `GZ=${latest.gyro_z_dps.toFixed(3)} dps`;

  // Fallback for old single-line element
  const gyroEl = document.getElementById('lastPayloadGyro');
  if (gyroEl) {
    gyroEl.textContent = `GX=${latest.gyro_x_dps.toFixed(3)} dps | GY=${latest.gyro_y_dps.toFixed(3)} dps | GZ=${latest.gyro_z_dps.toFixed(3)} dps`;
  }

  checkCollectionRateMismatch(latest);
}

function updateCardTimers() {
  if (lastSampleTs == null) return;
  const now = Date.now();
  const diff = (now - lastSampleTs) / 1000;
  const date = new Date(lastSampleTs);
  const text = date.toLocaleTimeString('pt-BR');

  document.querySelectorAll('.chart-timer').forEach(el => {
    el.textContent = text;
    if (diff > 2.0) el.style.color = '#ff5252';
    else el.style.color = 'rgba(255, 255, 255, 0.4)';
  });
}

function updateAlerts(latest) {
  if (!latest || latest.severity === 'NONE') {
    return;
  }
  alerts.unshift({
    severity: latest.severity,
    message: latest.message,
    time: new Date(latest.ts),
  });
  if (alerts.length > 10) {
    alerts.pop();
  }
  renderAlerts();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAlerts() {
  const el = document.getElementById('alertsList');
  if (alerts.length === 0) {
    el.innerHTML = '<div class="card-unit">Nenhum alerta ainda.</div>';
    return;
  }
  el.innerHTML = alerts.map(alert => {
    const sevKey = String(alert.severity || 'NONE').toLowerCase();
    const sourceKey = alert.source ? String(alert.source).toLowerCase().replace(/[^a-z0-9_-]/g, '') : '';
    const sourceHtml = alert.source
      ? ` <span class="alert-source source-${sourceKey}">${escapeHtml(alert.source)}</span>`
      : '';
    const timeStr = alert.time instanceof Date ? alert.time.toLocaleTimeString('pt-BR') : '--';
    const timeFull = alert.time instanceof Date ? alert.time.toLocaleString('pt-BR') : '';
    return `
      <div class="alert-item severity-${sevKey}">
        <div><strong>${escapeHtml(alert.severity)}</strong>${sourceHtml}: ${escapeHtml(alert.message)}</div>
        <div class="alert-time" title="${escapeHtml(timeFull)}">${escapeHtml(timeStr)}</div>
      </div>
    `;
  }).join('');
}

function calcMean(values) {
  if (!values.length) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function parseRateFromCollectionId(collectionId) {
  if (!collectionId) return null;
  // Allows patterns like "col_..._15hz" or "col_..._15hz_desc". Uses the last "_XXhz" found.
  const re = /_([0-9]+)hz(?![0-9])/gi;
  let m;
  let last = null;
  while ((m = re.exec(collectionId)) !== null) {
    last = m[1];
  }
  if (!last) return null;
  const rate = Number(last);
  return Number.isFinite(rate) ? rate : null;
}

function checkCollectionRateMismatch(latest) {
  if (!latest) return;
  const sampleRate = Number.isFinite(latest.sample_rate)
    ? latest.sample_rate
    : (lastServerConfig && Number.isFinite(lastServerConfig.sample_rate) ? lastServerConfig.sample_rate : null);
  const collectionId = latest.collection_id || '';
  if (!collectionId || sampleRate == null) return;

  const rateFromId = parseRateFromCollectionId(collectionId);
  if (!rateFromId) return;

  const mismatch = Math.round(rateFromId) !== Math.round(sampleRate);
  if (!mismatch) {
    lastCollectionRateWarning = null;
    return;
  }

  const now = Date.now();
  const warningKey = `${collectionId}|${sampleRate}`;
  if (lastCollectionRateWarning === warningKey && (now - lastCollectionRateWarningAt) < 60000) {
    return; // evita spam
  }

  lastCollectionRateWarning = warningKey;
  lastCollectionRateWarningAt = now;
  alerts.unshift({
    severity: 'MEDIUM',
    source: 'CONFIG',
    message: `Sessão indica ${Math.round(rateFromId)}Hz, mas taxa configurada é ${Math.round(sampleRate)}Hz (collection_id: "${collectionId}")`,
    time: new Date(latest.ts || now),
  });
  if (alerts.length > 10) {
    alerts.pop();
  }
  renderAlerts();
}

function calcRms(values) {
  if (!values.length) return 0;
  const sumSq = values.reduce((acc, v) => acc + v * v, 0);
  return Math.sqrt(sumSq / values.length);
}

function calcStd(values) {
  if (!values.length) return 0;
  const mean = calcMean(values);
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function computeStats(values) {
  const n = values.length;
  if (!n) return null;
  let sum = 0;
  let sumSq = 0;
  let min = values[0];
  let max = values[0];
  let minIdx = 0;
  let maxIdx = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    sum += v;
    sumSq += v * v;
    if (v < min) { min = v; minIdx = i; }
    if (v > max) { max = v; maxIdx = i; }
  }
  const mean = sum / n;
  const rms = Math.sqrt(sumSq / n);
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    variance += d * d;
  }
  variance /= n;
  const std = Math.sqrt(variance);
  return { mean, rms, min, max, std, minIdx, maxIdx };
}

function downloadChart(canvasId, filename) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const chartInstance = Chart.getChart(canvas);
  if (!chartInstance) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const link = document.createElement('a');
  link.download = `${filename}_${ts}.png`;
  link.href = chartInstance.toBase64Image('image/png', 1);
  link.click();
}

function calcMin(values) {
  return values.length ? Math.min(...values) : 0;
}

function calcMax(values) {
  return values.length ? Math.max(...values) : 0;
}

function setStatValue(ids, value, digits = 3) {
  const text = Number.isFinite(value) ? value.toFixed(digits) : '--';
  const list = Array.isArray(ids) ? ids : [ids];
  list.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  });
}

const CHART_STATE_TARGETS = [
  { id: 'accelXStatState', valueId: 'accelXStatStateValue' },
  { id: 'accelYStatState', valueId: 'accelYStatStateValue' },
  { id: 'accelZStatState', valueId: 'accelZStatStateValue' },
  { id: 'gyroXStatState', valueId: 'gyroXStatStateValue' },
  { id: 'gyroYStatState', valueId: 'gyroYStatStateValue' },
  { id: 'gyroZStatState', valueId: 'gyroZStatStateValue' },
];

function updateChartStatePills() {
  const pred = window.fanClassifier?.lastPrediction;
  let state = pred?.confirmedState || pred?.prediction || lastPayload?.fan_state || '--';
  if (!state || state === 'UNKNOWN') state = '--';
  const normalized = typeof state === 'string' ? state.toUpperCase() : '--';
  const knownLabel = _getModelLabels().includes(normalized);
  const color = knownLabel ? _classColor(normalized) : null;

  CHART_STATE_TARGETS.forEach(({ id, valueId }) => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(valueId);
    if (!el || !valEl) return;
    valEl.textContent = knownLabel ? _classShort(normalized) : normalized;
    el.className = 'chart-stat chart-stat-state';
    if (color) {
      el.style.borderColor = color + 'b3';
      el.style.background = color + '2e';
      el.style.color = color;
    } else {
      el.style.borderColor = '';
      el.style.background = '';
      el.style.color = '';
    }
  });
}

function updateMetrics(data) {
  const accelX = data.map(item => item.accel_x_g * G_TO_MS2);
  const accelY = data.map(item => item.accel_y_g * G_TO_MS2);
  const accelZ = data.map(item => item.accel_z_g * G_TO_MS2);
  const gyroX = data.map(item => item.gyro_x_dps);
  const gyroY = data.map(item => item.gyro_y_dps);
  const gyroZ = data.map(item => item.gyro_z_dps);

  const accelXStats = computeStats(accelX);
  const accelYStats = computeStats(accelY);
  const accelZStats = computeStats(accelZ);
  const gyroXStats = computeStats(gyroX);
  const gyroYStats = computeStats(gyroY);
  const gyroZStats = computeStats(gyroZ);

  setStatValue(['accelMeanX', 'accelXStatRms', 'accelMultiRmsX'], accelXStats?.rms);
  setStatValue(['accelMeanY', 'accelYStatRms', 'accelMultiRmsY'], accelYStats?.rms);
  setStatValue(['accelMeanZ', 'accelZStatRms', 'accelMultiRmsZ'], accelZStats?.rms);

  setStatValue(['accelMinX', 'accelXStatMin', 'accelMultiMinX'], accelXStats?.min);
  setStatValue(['accelMaxX', 'accelXStatMax', 'accelMultiMaxX'], accelXStats?.max);
  setStatValue(['accelStdX', 'accelXStatStd', 'accelMultiStdX'], accelXStats?.std);

  setStatValue(['accelMinY', 'accelYStatMin', 'accelMultiMinY'], accelYStats?.min);
  setStatValue(['accelMaxY', 'accelYStatMax', 'accelMultiMaxY'], accelYStats?.max);
  setStatValue(['accelStdY', 'accelYStatStd', 'accelMultiStdY'], accelYStats?.std);

  setStatValue(['accelMinZ', 'accelZStatMin', 'accelMultiMinZ'], accelZStats?.min);
  setStatValue(['accelMaxZ', 'accelZStatMax', 'accelMultiMaxZ'], accelZStats?.max);
  setStatValue(['accelStdZ', 'accelZStatStd', 'accelMultiStdZ'], accelZStats?.std);

  setStatValue(['gyroMeanX', 'gyroXStatRms', 'gyroMultiRmsX'], gyroXStats?.rms);
  setStatValue(['gyroMeanY', 'gyroYStatRms', 'gyroMultiRmsY'], gyroYStats?.rms);
  setStatValue(['gyroMeanZ', 'gyroZStatRms', 'gyroMultiRmsZ'], gyroZStats?.rms);

  setStatValue(['gyroMinX', 'gyroXStatMin', 'gyroMultiMinX'], gyroXStats?.min);
  setStatValue(['gyroMaxX', 'gyroXStatMax', 'gyroMultiMaxX'], gyroXStats?.max);
  setStatValue(['gyroStdX', 'gyroXStatStd', 'gyroMultiStdX'], gyroXStats?.std);

  setStatValue(['gyroMinY', 'gyroYStatMin', 'gyroMultiMinY'], gyroYStats?.min);
  setStatValue(['gyroMaxY', 'gyroYStatMax', 'gyroMultiMaxY'], gyroYStats?.max);
  setStatValue(['gyroStdY', 'gyroYStatStd', 'gyroMultiStdY'], gyroYStats?.std);

  setStatValue(['gyroMinZ', 'gyroZStatMin', 'gyroMultiMinZ'], gyroZStats?.min);
  setStatValue(['gyroMaxZ', 'gyroZStatMax', 'gyroMultiMaxZ'], gyroZStats?.max);
  setStatValue(['gyroStdZ', 'gyroZStatStd', 'gyroMultiStdZ'], gyroZStats?.std);

  // Store latest stats for reference match highlighting
  _latestAxisStats = {
    accel_x_g: accelXStats,
    accel_y_g: accelYStats,
    accel_z_g: accelZStats,
    gyro_x_dps: gyroXStats,
    gyro_y_dps: gyroYStats,
    gyro_z_dps: gyroZStats,
  };
  // Apply per-class reference lines on the plots based on the ML confirmed state.
  // This makes mechanical drift (e.g., sensor tilt) visible as deviation from the expected baseline.
  updateOverlayBaselinesFromClassifierState();
  updateRefMatchHighlight();

  updateChartStatePills();
}

function resetMetrics() {
  const ids = [
    'accelMeanX','accelMeanY','accelMeanZ',
    'accelMinX','accelMaxX','accelStdX',
    'accelMinY','accelMaxY','accelStdY',
    'accelMinZ','accelMaxZ','accelStdZ',
    'gyroMeanX','gyroMeanY','gyroMeanZ',
    'gyroMinX','gyroMaxX','gyroStdX',
    'gyroMinY','gyroMaxY','gyroStdY',
    'gyroMinZ','gyroMaxZ','gyroStdZ',
    'accelXStatRms','accelXStatMin','accelXStatMax','accelXStatStd',
    'accelYStatRms','accelYStatMin','accelYStatMax','accelYStatStd',
    'accelZStatRms','accelZStatMin','accelZStatMax','accelZStatStd',
    'gyroXStatRms','gyroXStatMin','gyroXStatMax','gyroXStatStd',
    'gyroYStatRms','gyroYStatMin','gyroYStatMax','gyroYStatStd',
    'gyroZStatRms','gyroZStatMin','gyroZStatMax','gyroZStatStd',
    'accelMultiRmsX','accelMultiMinX','accelMultiMaxX','accelMultiStdX',
    'accelMultiRmsY','accelMultiMinY','accelMultiMaxY','accelMultiStdY',
    'accelMultiRmsZ','accelMultiMinZ','accelMultiMaxZ','accelMultiStdZ',
    'gyroMultiRmsX','gyroMultiMinX','gyroMultiMaxX','gyroMultiStdX',
    'gyroMultiRmsY','gyroMultiMinY','gyroMultiMaxY','gyroMultiStdY',
    'gyroMultiRmsZ','gyroMultiMinZ','gyroMultiMaxZ','gyroMultiStdZ',
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '--';
  });
  CHART_STATE_TARGETS.forEach(({ id, valueId }) => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(valueId);
    if (valEl) valEl.textContent = '--';
    if (el) el.className = 'chart-stat chart-stat-state';
  });
}

function mapSeries(data, valueFn) {
  return data.map(item => ({ x: item.ts, y: valueFn(item) }));
}

// Configuração genérica para criar gráficos com Chart.js
function setupChart(ctx, label, color, minSpan, fixedMin, fixedMax) {
  return new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: label,
        data: [],
        borderColor: color,
        backgroundColor: color + '22',
        borderWidth: 2,
        tension: window.CHART_TENSION || 0,
        fill: false,
        pointRadius: 2,
        pointHoverRadius: 4,
        spanGaps: CONFIG.GAP_THRESHOLD_MS,
      }],
    },
    options: {
      parsing: false,
      normalized: true,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: '#0f172a',
            filter: (item, data) => !data.datasets[item.datasetIndex]?.skipLegend,
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (!items || !items.length) return '';
              return formatDateTimeLabel(items[0].parsed.x);
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            color: '#64748b',
            maxRotation: 0,
            autoSkip: true,
            callback: (value) => formatRelativeTimeLabel(value),
          },
          grid: { color: 'rgba(148,163,184,0.2)' },
        },
        y: { ticks: { color: '#64748b' }, grid: { color: 'rgba(148,163,184,0.2)' }, minSpan: minSpan || 0, fixedMin: fixedMin, fixedMax: fixedMax },
      },
    },
  });
}

function setupMultiChart(ctx, labels, colors, minSpan, fixedMin, fixedMax) {
  return new Chart(ctx, {
    type: 'line',
    data: {
      datasets: labels.map((label, idx) => ({
        label: label,
        data: [],
        borderColor: colors[idx],
        backgroundColor: colors[idx] + '22',
        borderWidth: 2,
        tension: window.CHART_TENSION || 0,
        fill: false,
        pointRadius: 2,
        pointHoverRadius: 4,
        spanGaps: CONFIG.GAP_THRESHOLD_MS,
      })),
    },
    options: {
      parsing: false,
      normalized: true,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: '#0f172a',
            filter: (item, data) => !data.datasets[item.datasetIndex]?.skipLegend,
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (!items || !items.length) return '';
              return formatDateTimeLabel(items[0].parsed.x);
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            color: '#64748b',
            maxRotation: 0,
            autoSkip: true,
            callback: (value) => formatRelativeTimeLabel(value),
          },
          grid: { color: 'rgba(148,163,184,0.2)' },
        },
        y: { ticks: { color: '#64748b' }, grid: { color: 'rgba(148,163,184,0.2)' }, minSpan: minSpan || 0, fixedMin: fixedMin, fixedMax: fixedMax },
      },
    },
  });
}

function addAxisOverlays(chart, axisKey, color) {
  const rmsColor = color + 'cc';
  const meanColor = color + '99';
  const stdColor = color + '77';
  const minMaxColor = color + '66';
  const bandColor = color + '1a';
  const baselineMeanColor = color + 'bb';
  const baselineStdColor = color + '88';
  const makeLine = (label, lineColor, dash = [], width = 2) => ({
    label,
    data: [],
    borderColor: lineColor,
    borderWidth: width,
    borderDash: dash,
    pointRadius: 0,
    pointHoverRadius: 0,
    fill: false,
    skipLegend: true,
    order: 10,
  });
  const makeBandFill = (label, targetIdx) => ({
    label,
    data: [],
    borderColor: 'transparent',
    borderWidth: 0,
    pointRadius: 0,
    pointHoverRadius: 0,
    fill: { target: targetIdx, above: bandColor, below: bandColor },
    backgroundColor: bandColor,
    skipLegend: true,
    order: 6,
  });
  const makePoint = (label, style) => ({
    label,
    data: [],
    borderColor: color,
    backgroundColor: color,
    pointStyle: style,
    pointRadius: 6,
    pointHoverRadius: 8,
    showLine: false,
    fill: false,
    skipLegend: true,
    order: 12,
  });

  const rmsPosIdx = chart.data.datasets.push(makeLine(`${axisKey}-RMS-POS`, rmsColor, [8, 4])) - 1;
  const rmsNegIdx = chart.data.datasets.push(makeLine(`${axisKey}-RMS-NEG`, rmsColor, [8, 4])) - 1;
  const meanIdx = chart.data.datasets.push(makeLine(`${axisKey}-MEAN`, meanColor, [2, 6])) - 1;
  const stdLowIdx = chart.data.datasets.push(makeLine(`${axisKey}-STD-LOW`, stdColor, [4, 4])) - 1;
  const stdHighIdx = chart.data.datasets.push(makeLine(`${axisKey}-STD-HIGH`, stdColor, [4, 4])) - 1;
  const stdBandIdx = chart.data.datasets.push(makeBandFill(`${axisKey}-STD-BAND`, stdLowIdx)) - 1;
  const baseMeanIdx = chart.data.datasets.push(makeLine(`${axisKey}-BASE-MEAN`, baselineMeanColor, [], 2)) - 1;
  const baseStdLowIdx = chart.data.datasets.push(makeLine(`${axisKey}-BASE-STD-LOW`, baselineStdColor, [], 1.5)) - 1;
  const baseStdHighIdx = chart.data.datasets.push(makeLine(`${axisKey}-BASE-STD-HIGH`, baselineStdColor, [], 1.5)) - 1;
  const minIdx = chart.data.datasets.push(makeLine(`${axisKey}-MIN`, minMaxColor, [1, 6], 2)) - 1;
  const maxIdx = chart.data.datasets.push(makeLine(`${axisKey}-MAX`, minMaxColor, [1, 6], 2)) - 1;
  const minPointIdx = chart.data.datasets.push(makePoint(`${axisKey}-MIN-PT`, 'rectRot')) - 1;
  const maxPointIdx = chart.data.datasets.push(makePoint(`${axisKey}-MAX-PT`, 'rectRot')) - 1;

  return {
    rmsPosIdx, rmsNegIdx, meanIdx, minIdx, maxIdx,
    stdLowIdx, stdHighIdx, stdBandIdx,
    baseMeanIdx, baseStdLowIdx, baseStdHighIdx,
    minPointIdx, maxPointIdx,
  };
}

function initMultiChartOverlays(chart, axes) {
  chart.$overlays = {};
  axes.forEach(axis => {
    chart.$overlays[axis.key] = addAxisOverlays(chart, axis.key, axis.color);
  });
}

function initSingleChartOverlays(chart, axisKey, color) {
  chart.$overlays = { [axisKey]: addAxisOverlays(chart, axisKey, color) };
}

function setChartBaseline(chart, axisKey, baseline) {
  if (!chart.$baseline) chart.$baseline = {};
  chart.$baseline[axisKey] = baseline || null;
}

function pushBaselineScale(values, baseline) {
  if (!baseline) return;
  const mean = baseline.mean;
  const std = baseline.std;
  if (!Number.isFinite(mean) || !Number.isFinite(std)) return;
  values.push(mean, mean - std, mean + std);
}

// =============================================================================
// PER-CLASS BASELINES (CHART OVERLAYS)
// - Uses config/eda_baselines_per_class.json (or adapted baselines from Soak)
// - Applies the baseline for the current confirmed class to the chart overlays
//   (mean and mean±std lines). This makes mechanical drift visible in the plots.
// =============================================================================

let _lastOverlayBaselineClass = null;
let _lastOverlayBaselineSource = null; // 'training' | 'adapted'

function _toMeanStd(baselineAxis) {
  const mean = baselineAxis?.mean;
  const std = baselineAxis?.std;
  if (!Number.isFinite(mean) || !Number.isFinite(std)) return null;
  return { mean, std };
}

function applyPerClassBaselinesToCharts(cls) {
  const baselines = getActivePerClassBaselines();
  const classData = baselines?.[cls] || null;
  if (!classData) return false;

  // Fallbacks: if some axis is missing, keep global EDA baseline so overlays don't vanish.
  const accelX = _toMeanStd(classData.accel_x_g) || EDA_BASELINES.accel.x;
  const accelY = _toMeanStd(classData.accel_y_g) || EDA_BASELINES.accel.y;
  const accelZ = _toMeanStd(classData.accel_z_g) || EDA_BASELINES.accel.z;
  const gyroX = _toMeanStd(classData.gyro_x_dps) || EDA_BASELINES.gyro.x;
  const gyroY = _toMeanStd(classData.gyro_y_dps) || EDA_BASELINES.gyro.y;
  const gyroZ = _toMeanStd(classData.gyro_z_dps) || EDA_BASELINES.gyro.z;

  // Multi charts
  setChartBaseline(accelChart, 'x', accelX);
  setChartBaseline(accelChart, 'y', accelY);
  setChartBaseline(accelChart, 'z', accelZ);
  setChartBaseline(gyroChart, 'x', gyroX);
  setChartBaseline(gyroChart, 'y', gyroY);
  setChartBaseline(gyroChart, 'z', gyroZ);

  // Single charts
  setChartBaseline(accelXChart, 'x', accelX);
  setChartBaseline(accelYChart, 'y', accelY);
  setChartBaseline(accelZChart, 'z', accelZ);
  setChartBaseline(gyroXChart, 'x', gyroX);
  setChartBaseline(gyroYChart, 'y', gyroY);
  setChartBaseline(gyroZChart, 'z', gyroZ);

  return true;
}

function resetChartBaselinesToDefault() {
  // Multi charts
  setChartBaseline(accelChart, 'x', EDA_BASELINES.accel.x);
  setChartBaseline(accelChart, 'y', EDA_BASELINES.accel.y);
  setChartBaseline(accelChart, 'z', EDA_BASELINES.accel.z);
  setChartBaseline(gyroChart, 'x', EDA_BASELINES.gyro.x);
  setChartBaseline(gyroChart, 'y', EDA_BASELINES.gyro.y);
  setChartBaseline(gyroChart, 'z', EDA_BASELINES.gyro.z);

  // Single charts
  setChartBaseline(accelXChart, 'x', EDA_BASELINES.accel.x);
  setChartBaseline(accelYChart, 'y', EDA_BASELINES.accel.y);
  setChartBaseline(accelZChart, 'z', EDA_BASELINES.accel.z);
  setChartBaseline(gyroXChart, 'x', EDA_BASELINES.gyro.x);
  setChartBaseline(gyroYChart, 'y', EDA_BASELINES.gyro.y);
  setChartBaseline(gyroZChart, 'z', EDA_BASELINES.gyro.z);
}

function updateOverlayBaselinesFromClassifierState() {
  const pred = window.fanClassifier?.lastPrediction || null;
  const cls = pred?.confirmedState || null;
  const clsStr = cls ? String(cls).toUpperCase() : null;
  const validCls = clsStr && _getModelLabels().includes(clsStr) ? clsStr : null;
  const source = refBaselinesSource || 'training';

  if (validCls) {
    if (validCls !== _lastOverlayBaselineClass || source !== _lastOverlayBaselineSource) {
      const ok = applyPerClassBaselinesToCharts(validCls);
      if (ok) {
        _lastOverlayBaselineClass = validCls;
        _lastOverlayBaselineSource = source;
      }
    }
  } else {
    if (_lastOverlayBaselineClass !== null) {
      resetChartBaselinesToDefault();
      _lastOverlayBaselineClass = null;
      _lastOverlayBaselineSource = null;
    }
  }
}

function updateAxisOverlays(chart, axisKey, stats, timestamps, xStart, xEnd) {
  const overlay = chart.$overlays?.[axisKey];
  if (!overlay) return;
  const datasets = chart.data.datasets;
  const clear = () => {
    datasets[overlay.rmsPosIdx].data = [];
    datasets[overlay.rmsNegIdx].data = [];
    datasets[overlay.meanIdx].data = [];
    datasets[overlay.minIdx].data = [];
    datasets[overlay.maxIdx].data = [];
    datasets[overlay.stdLowIdx].data = [];
    datasets[overlay.stdHighIdx].data = [];
    datasets[overlay.stdBandIdx].data = [];
    datasets[overlay.minPointIdx].data = [];
    datasets[overlay.maxPointIdx].data = [];
    datasets[overlay.baseMeanIdx].data = [];
    datasets[overlay.baseStdLowIdx].data = [];
    datasets[overlay.baseStdHighIdx].data = [];
  };
  if (!stats || !timestamps.length || !Number.isFinite(xStart) || !Number.isFinite(xEnd)) {
    clear();
    return;
  }

  const rms = stats.rms;
  const mean = stats.mean;
  const min = stats.min;
  const max = stats.max;
  const std = stats.std;
  const lower = mean - std;
  const upper = mean + std;

  datasets[overlay.rmsPosIdx].data = [{ x: xStart, y: rms }, { x: xEnd, y: rms }];
  datasets[overlay.rmsNegIdx].data = [{ x: xStart, y: -rms }, { x: xEnd, y: -rms }];
  datasets[overlay.meanIdx].data = [{ x: xStart, y: mean }, { x: xEnd, y: mean }];
  datasets[overlay.minIdx].data = [{ x: xStart, y: min }, { x: xEnd, y: min }];
  datasets[overlay.maxIdx].data = [{ x: xStart, y: max }, { x: xEnd, y: max }];
  datasets[overlay.stdLowIdx].data = [{ x: xStart, y: lower }, { x: xEnd, y: lower }];
  datasets[overlay.stdHighIdx].data = [{ x: xStart, y: upper }, { x: xEnd, y: upper }];
  datasets[overlay.stdBandIdx].data = [{ x: xStart, y: upper }, { x: xEnd, y: upper }];

  const minTs = timestamps[stats.minIdx];
  const maxTs = timestamps[stats.maxIdx];
  datasets[overlay.minPointIdx].data = Number.isFinite(minTs) ? [{ x: minTs, y: min }] : [];
  datasets[overlay.maxPointIdx].data = Number.isFinite(maxTs) ? [{ x: maxTs, y: max }] : [];

  const baseline = chart.$baseline?.[axisKey];
  if (baseline && Number.isFinite(baseline.mean) && Number.isFinite(baseline.std)) {
    const bMean = baseline.mean;
    const bLow = bMean - baseline.std;
    const bHigh = bMean + baseline.std;
    datasets[overlay.baseMeanIdx].data = [{ x: xStart, y: bMean }, { x: xEnd, y: bMean }];
    datasets[overlay.baseStdLowIdx].data = [{ x: xStart, y: bLow }, { x: xEnd, y: bLow }];
    datasets[overlay.baseStdHighIdx].data = [{ x: xStart, y: bHigh }, { x: xEnd, y: bHigh }];
  } else {
    datasets[overlay.baseMeanIdx].data = [];
    datasets[overlay.baseStdLowIdx].data = [];
    datasets[overlay.baseStdHighIdx].data = [];
  }
}

const tempChart = setupChart(document.getElementById('tempChart').getContext('2d'), 'Temperatura (°C)', '#f97316', 5, 0, 60);
const accelChart = setupMultiChart(document.getElementById('accelChart').getContext('2d'), ['Accel X', 'Accel Y', 'Accel Z'], ['#ef4444', '#22c55e', '#3b82f6'], 0.5, -2, 2);
const gyroChart = setupMultiChart(document.getElementById('gyroChart').getContext('2d'), ['Gyro X', 'Gyro Y', 'Gyro Z'], ['#f59e0b', '#8b5cf6', '#06b6d4'], 5, -250, 250);
const vibrationChart = setupChart(document.getElementById('vibrationChart').getContext('2d'), 'Vibracao (dps)', '#0ea5e9', 5, 0, 3000);

const accelXChart = setupChart(document.getElementById('accelXChart').getContext('2d'), 'Accel X (g)', '#ef4444', 0.5, -2, 2);
const accelYChart = setupChart(document.getElementById('accelYChart').getContext('2d'), 'Accel Y (g)', '#22c55e', 0.5, -2, 2);
const accelZChart = setupChart(document.getElementById('accelZChart').getContext('2d'), 'Accel Z (g)', '#3b82f6', 0.5, -2, 2);

const gyroXChart = setupChart(document.getElementById('gyroXChart').getContext('2d'), 'Gyro X (dps)', '#f59e0b', 5, -250, 250);
const gyroYChart = setupChart(document.getElementById('gyroYChart').getContext('2d'), 'Gyro Y (dps)', '#8b5cf6', 5, -250, 250);
const gyroZChart = setupChart(document.getElementById('gyroZChart').getContext('2d'), 'Gyro Z (dps)', '#06b6d4', 5, -250, 250);

initMultiChartOverlays(accelChart, [
  { key: 'x', color: '#ef4444' },
  { key: 'y', color: '#22c55e' },
  { key: 'z', color: '#3b82f6' },
]);
initMultiChartOverlays(gyroChart, [
  { key: 'x', color: '#f59e0b' },
  { key: 'y', color: '#8b5cf6' },
  { key: 'z', color: '#06b6d4' },
]);
initSingleChartOverlays(accelXChart, 'x', '#ef4444');
initSingleChartOverlays(accelYChart, 'y', '#22c55e');
initSingleChartOverlays(accelZChart, 'z', '#3b82f6');
initSingleChartOverlays(gyroXChart, 'x', '#f59e0b');
initSingleChartOverlays(gyroYChart, 'y', '#8b5cf6');
initSingleChartOverlays(gyroZChart, 'z', '#06b6d4');

setChartBaseline(accelChart, 'x', EDA_BASELINES.accel.x);
setChartBaseline(accelChart, 'y', EDA_BASELINES.accel.y);
setChartBaseline(accelChart, 'z', EDA_BASELINES.accel.z);
setChartBaseline(gyroChart, 'x', EDA_BASELINES.gyro.x);
setChartBaseline(gyroChart, 'y', EDA_BASELINES.gyro.y);
setChartBaseline(gyroChart, 'z', EDA_BASELINES.gyro.z);
setChartBaseline(accelXChart, 'x', EDA_BASELINES.accel.x);
setChartBaseline(accelYChart, 'y', EDA_BASELINES.accel.y);
setChartBaseline(accelZChart, 'z', EDA_BASELINES.accel.z);
setChartBaseline(gyroXChart, 'x', EDA_BASELINES.gyro.x);
setChartBaseline(gyroYChart, 'y', EDA_BASELINES.gyro.y);
setChartBaseline(gyroZChart, 'z', EDA_BASELINES.gyro.z);

const chartScaleOverrides = {};

// =============================================================================
// CHART ZOOM CONTROLS (X time range + Y minSpan presets)
// =============================================================================

const TIME_RANGE_ZOOM_STEPS = ['30s', '1m', '5m', '10m', '1h', '6h', 'all']; // small -> large

const CHART_Y_ZOOM_PRESETS = {
  // Values are y-axis minimum span presets (data units).
  temp:      [0.5, 1, 2, 5, 10],
  vibration: [1, 2, 5, 10, 25, 50, 100],
  accel:     [0.2, 0.5, 1, 2, 4, 8],
  accelX:    [0.2, 0.5, 1, 2, 4, 8],
  accelY:    [0.2, 0.5, 1, 2, 4, 8],
  accelZ:    [0.2, 0.5, 1, 2, 4, 8],
  gyro:      [2, 5, 10, 25, 50, 100, 250],
  gyroX:     [2, 5, 10, 25, 50, 100, 250],
  gyroY:     [2, 5, 10, 25, 50, 100, 250],
  gyroZ:     [2, 5, 10, 25, 50, 100, 250],
};

const CHART_Y_ZOOM_DEFAULT_MINSPAN = {
  temp: 5,
  vibration: 5,
  accel: 0.5,
  accelX: 0.5,
  accelY: 0.5,
  accelZ: 0.5,
  gyro: 5,
  gyroX: 5,
  gyroY: 5,
  gyroZ: 5,
};

const CHART_Y_ZOOM_UNITS = {
  temp: '°C',
  vibration: 'dps',
  accel: 'g',
  accelX: 'g',
  accelY: 'g',
  accelZ: 'g',
  gyro: 'dps',
  gyroX: 'dps',
  gyroY: 'dps',
  gyroZ: 'dps',
};

function clampToPreset(chartKey, value) {
  const presets = CHART_Y_ZOOM_PRESETS[chartKey];
  if (!presets || !presets.length || !Number.isFinite(value)) return null;
  let best = presets[0];
  let bestDist = Math.abs(value - best);
  for (const v of presets) {
    const dist = Math.abs(value - v);
    if (dist < bestDist) { bestDist = dist; best = v; }
  }
  return best;
}

function getCurrentYZoomSpan(chartKey) {
  const v = chartScaleOverrides[chartKey];
  return Number.isFinite(v) ? v : null;
}

function setCurrentYZoomSpan(chartKey, span) {
  if (!Number.isFinite(span)) return;
  chartScaleOverrides[chartKey] = span;
}

function clearCurrentYZoomSpan(chartKey) {
  delete chartScaleOverrides[chartKey];
}

function getYZoomStorageKey(chartKey) {
  return `iot_dashboard_yzoom_${chartKey}`;
}

function persistYZoom(chartKey, spanOrAuto) {
  try {
    localStorage.setItem(getYZoomStorageKey(chartKey), spanOrAuto);
  } catch (e) {
    // ignore
  }
}

function restoreYZoomOverrides() {
  Object.keys(CHART_Y_ZOOM_PRESETS).forEach(chartKey => {
    let raw = null;
    try {
      raw = localStorage.getItem(getYZoomStorageKey(chartKey));
    } catch (e) {
      raw = null;
    }
    if (!raw || raw === 'auto') {
      return;
    }
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    const clamped = clampToPreset(chartKey, parsed);
    if (clamped != null) {
      setCurrentYZoomSpan(chartKey, clamped);
    }
  });
}

function formatYZoomReadout(chartKey) {
  const unit = CHART_Y_ZOOM_UNITS[chartKey] || '';
  const current = getCurrentYZoomSpan(chartKey);
  if (current == null) return 'Y: Auto';
  const txt = (Math.abs(current) >= 10) ? String(Math.round(current)) : String(current);
  return `Y: >= ${txt}${unit ? ' ' + unit : ''}`;
}

function syncYZoomUI(chartKey) {
  const readout = document.querySelector(`[data-yzoom-readout="${chartKey}"]`);
  if (readout) readout.textContent = formatYZoomReadout(chartKey);

  const autoBtn = document.querySelector(`[data-yzoom-target="${chartKey}"][data-yzoom="auto"]`);
  if (autoBtn) {
    autoBtn.classList.toggle('active', getCurrentYZoomSpan(chartKey) == null);
  }
}

function setYZoomAuto(chartKey) {
  clearCurrentYZoomSpan(chartKey);
  persistYZoom(chartKey, 'auto');
  syncYZoomUI(chartKey);
  renderAll();
}

function stepYZoom(chartKey, direction) {
  const presets = CHART_Y_ZOOM_PRESETS[chartKey];
  if (!presets || !presets.length) return;

  const defaultSpan = CHART_Y_ZOOM_DEFAULT_MINSPAN[chartKey] ?? presets[Math.floor(presets.length / 2)];
  const currentSpan = getCurrentYZoomSpan(chartKey) ?? defaultSpan;

  const clamped = clampToPreset(chartKey, currentSpan) ?? presets[0];
  let idx = presets.indexOf(clamped);
  if (idx < 0) idx = 0;

  // Y+ == zoom in => smaller minSpan; Y- == zoom out => larger minSpan
  if (direction === 'in') {
    idx = Math.max(0, idx - 1);
  } else if (direction === 'out') {
    idx = Math.min(presets.length - 1, idx + 1);
  } else {
    return;
  }

  const next = presets[idx];
  setCurrentYZoomSpan(chartKey, next);
  persistYZoom(chartKey, String(next));
  syncYZoomUI(chartKey);
  renderAll();
}

restoreYZoomOverrides();

function setAutoScale(chart, values, chartKey) {
  if (!values.length) {
    return;
  }
  let min = Math.min(...values);
  let max = Math.max(...values);
  let span = max - min;
  const minSpan = chartKey && chartScaleOverrides[chartKey] != null ? chartScaleOverrides[chartKey] : (chart.options.scales.y.minSpan || 0);
  if (span < minSpan) {
    const mid = (max + min) / 2;
    min = mid - minSpan / 2;
    max = mid + minSpan / 2;
    span = minSpan;
  }
  const pad = Math.max(0.05, span * 0.1);
  chart.options.scales.y.min = min - pad;
  chart.options.scales.y.max = max + pad;
}

// Atualiza os dados dentro dos objetos Chart.js
function refreshCharts(filtered, limits) {
  const temps = filtered.map(item => item.temperature);
  const accelX = filtered.map(item => item.accel_x_g * G_TO_MS2);
  const accelY = filtered.map(item => item.accel_y_g * G_TO_MS2);
  const accelZ = filtered.map(item => item.accel_z_g * G_TO_MS2);
  const gyroX = filtered.map(item => item.gyro_x_dps);
  const gyroY = filtered.map(item => item.gyro_y_dps);
  const gyroZ = filtered.map(item => item.gyro_z_dps);
  const vibration = filtered.map(item => item.vibration_dps != null ? item.vibration_dps : item.vibration);
  const tsSeries = filtered.map(item => item.ts);

  const accelXStats = computeStats(accelX);
  const accelYStats = computeStats(accelY);
  const accelZStats = computeStats(accelZ);
  const gyroXStats = computeStats(gyroX);
  const gyroYStats = computeStats(gyroY);
  const gyroZStats = computeStats(gyroZ);

  // Aplica os limites do eixo X (zoom/scroll) em todos os gráficos
  const charts = [tempChart, accelChart, gyroChart, vibrationChart, accelXChart, accelYChart, accelZChart, gyroXChart, gyroYChart, gyroZChart];
  charts.forEach(chart => {
    if (limits && limits.start !== null) {
      chart.options.scales.x.min = limits.start;
      chart.options.scales.x.max = limits.end;
    } else {
      delete chart.options.scales.x.min;
      delete chart.options.scales.x.max;
    }
  });

  tempChart.data.datasets[0].data = mapSeries(filtered, item => item.temperature);
  setAutoScale(tempChart, temps, 'temp');
  tempChart.update('none');

  accelChart.data.datasets[0].data = mapSeries(filtered, item => item.accel_x_g * G_TO_MS2);
  accelChart.data.datasets[1].data = mapSeries(filtered, item => item.accel_y_g * G_TO_MS2);
  accelChart.data.datasets[2].data = mapSeries(filtered, item => item.accel_z_g * G_TO_MS2);
  const accelScaleValues = [...accelX, ...accelY, ...accelZ];
  if (accelXStats) accelScaleValues.push(
    accelXStats.mean - accelXStats.std,
    accelXStats.mean + accelXStats.std,
    accelXStats.rms,
    -accelXStats.rms
  );
  if (accelYStats) accelScaleValues.push(
    accelYStats.mean - accelYStats.std,
    accelYStats.mean + accelYStats.std,
    accelYStats.rms,
    -accelYStats.rms
  );
  if (accelZStats) accelScaleValues.push(
    accelZStats.mean - accelZStats.std,
    accelZStats.mean + accelZStats.std,
    accelZStats.rms,
    -accelZStats.rms
  );
  pushBaselineScale(accelScaleValues, EDA_BASELINES.accel.x);
  pushBaselineScale(accelScaleValues, EDA_BASELINES.accel.y);
  pushBaselineScale(accelScaleValues, EDA_BASELINES.accel.z);
  setAutoScale(accelChart, accelScaleValues, 'accel');
  const accelStart = limits && limits.start !== null ? limits.start : tsSeries[0];
  const accelEnd = limits && limits.end !== null ? limits.end : tsSeries[tsSeries.length - 1];
  updateAxisOverlays(accelChart, 'x', accelXStats, tsSeries, accelStart, accelEnd);
  updateAxisOverlays(accelChart, 'y', accelYStats, tsSeries, accelStart, accelEnd);
  updateAxisOverlays(accelChart, 'z', accelZStats, tsSeries, accelStart, accelEnd);
  accelChart.update('none');

  gyroChart.data.datasets[0].data = mapSeries(filtered, item => item.gyro_x_dps);
  gyroChart.data.datasets[1].data = mapSeries(filtered, item => item.gyro_y_dps);
  gyroChart.data.datasets[2].data = mapSeries(filtered, item => item.gyro_z_dps);
  const gyroScaleValues = [...gyroX, ...gyroY, ...gyroZ];
  if (gyroXStats) gyroScaleValues.push(
    gyroXStats.mean - gyroXStats.std,
    gyroXStats.mean + gyroXStats.std,
    gyroXStats.rms,
    -gyroXStats.rms
  );
  if (gyroYStats) gyroScaleValues.push(
    gyroYStats.mean - gyroYStats.std,
    gyroYStats.mean + gyroYStats.std,
    gyroYStats.rms,
    -gyroYStats.rms
  );
  if (gyroZStats) gyroScaleValues.push(
    gyroZStats.mean - gyroZStats.std,
    gyroZStats.mean + gyroZStats.std,
    gyroZStats.rms,
    -gyroZStats.rms
  );
  pushBaselineScale(gyroScaleValues, EDA_BASELINES.gyro.x);
  pushBaselineScale(gyroScaleValues, EDA_BASELINES.gyro.y);
  pushBaselineScale(gyroScaleValues, EDA_BASELINES.gyro.z);
  setAutoScale(gyroChart, gyroScaleValues, 'gyro');
  const gyroStart = limits && limits.start !== null ? limits.start : tsSeries[0];
  const gyroEnd = limits && limits.end !== null ? limits.end : tsSeries[tsSeries.length - 1];
  updateAxisOverlays(gyroChart, 'x', gyroXStats, tsSeries, gyroStart, gyroEnd);
  updateAxisOverlays(gyroChart, 'y', gyroYStats, tsSeries, gyroStart, gyroEnd);
  updateAxisOverlays(gyroChart, 'z', gyroZStats, tsSeries, gyroStart, gyroEnd);
  gyroChart.update('none');

  vibrationChart.data.datasets[0].data = mapSeries(filtered, item => item.vibration_dps != null ? item.vibration_dps : item.vibration);
  setAutoScale(vibrationChart, vibration, 'vibration');
  vibrationChart.update('none');

  accelXChart.data.datasets[0].data = mapSeries(filtered, item => item.accel_x_g * G_TO_MS2);
  const accelXScaleValues = accelX.slice();
  if (accelXStats) accelXScaleValues.push(
    accelXStats.mean - accelXStats.std,
    accelXStats.mean + accelXStats.std,
    accelXStats.rms,
    -accelXStats.rms
  );
  pushBaselineScale(accelXScaleValues, EDA_BASELINES.accel.x);
  setAutoScale(accelXChart, accelXScaleValues, 'accelX');
  updateAxisOverlays(accelXChart, 'x', accelXStats, tsSeries, accelStart, accelEnd);
  accelXChart.update('none');

  accelYChart.data.datasets[0].data = mapSeries(filtered, item => item.accel_y_g * G_TO_MS2);
  const accelYScaleValues = accelY.slice();
  if (accelYStats) accelYScaleValues.push(
    accelYStats.mean - accelYStats.std,
    accelYStats.mean + accelYStats.std,
    accelYStats.rms,
    -accelYStats.rms
  );
  pushBaselineScale(accelYScaleValues, EDA_BASELINES.accel.y);
  setAutoScale(accelYChart, accelYScaleValues, 'accelY');
  updateAxisOverlays(accelYChart, 'y', accelYStats, tsSeries, accelStart, accelEnd);
  accelYChart.update('none');

  accelZChart.data.datasets[0].data = mapSeries(filtered, item => item.accel_z_g * G_TO_MS2);
  const accelZScaleValues = accelZ.slice();
  if (accelZStats) accelZScaleValues.push(
    accelZStats.mean - accelZStats.std,
    accelZStats.mean + accelZStats.std,
    accelZStats.rms,
    -accelZStats.rms
  );
  pushBaselineScale(accelZScaleValues, EDA_BASELINES.accel.z);
  setAutoScale(accelZChart, accelZScaleValues, 'accelZ');
  updateAxisOverlays(accelZChart, 'z', accelZStats, tsSeries, accelStart, accelEnd);
  accelZChart.update('none');

  gyroXChart.data.datasets[0].data = mapSeries(filtered, item => item.gyro_x_dps);
  const gyroXScaleValues = gyroX.slice();
  if (gyroXStats) gyroXScaleValues.push(
    gyroXStats.mean - gyroXStats.std,
    gyroXStats.mean + gyroXStats.std,
    gyroXStats.rms,
    -gyroXStats.rms
  );
  pushBaselineScale(gyroXScaleValues, EDA_BASELINES.gyro.x);
  setAutoScale(gyroXChart, gyroXScaleValues, 'gyroX');
  updateAxisOverlays(gyroXChart, 'x', gyroXStats, tsSeries, gyroStart, gyroEnd);
  gyroXChart.update('none');

  gyroYChart.data.datasets[0].data = mapSeries(filtered, item => item.gyro_y_dps);
  const gyroYScaleValues = gyroY.slice();
  if (gyroYStats) gyroYScaleValues.push(
    gyroYStats.mean - gyroYStats.std,
    gyroYStats.mean + gyroYStats.std,
    gyroYStats.rms,
    -gyroYStats.rms
  );
  pushBaselineScale(gyroYScaleValues, EDA_BASELINES.gyro.y);
  setAutoScale(gyroYChart, gyroYScaleValues, 'gyroY');
  updateAxisOverlays(gyroYChart, 'y', gyroYStats, tsSeries, gyroStart, gyroEnd);
  gyroYChart.update('none');

  gyroZChart.data.datasets[0].data = mapSeries(filtered, item => item.gyro_z_dps);
  const gyroZScaleValues = gyroZ.slice();
  if (gyroZStats) gyroZScaleValues.push(
    gyroZStats.mean - gyroZStats.std,
    gyroZStats.mean + gyroZStats.std,
    gyroZStats.rms,
    -gyroZStats.rms
  );
  pushBaselineScale(gyroZScaleValues, EDA_BASELINES.gyro.z);
  setAutoScale(gyroZChart, gyroZScaleValues, 'gyroZ');
  updateAxisOverlays(gyroZChart, 'z', gyroZStats, tsSeries, gyroStart, gyroEnd);
  gyroZChart.update('none');
}

// Função principal de renderização: filtra dados e atualiza UI
function renderAll() {
  const limits = getWindowLimits();
  let filtered;

  if (CONFIG.TIME_RANGE === 'all') {
    filtered = cache.filter(item => item.ts <= limits.end);
  } else {
    // Buffer de 2s para garantir que as linhas cheguem até a borda do gráfico
    const buffer = 2000;
    filtered = cache.filter(item => item.ts >= (limits.start - buffer) && item.ts <= (limits.end + buffer));
  }

  filtered = sanitizeSeries(filtered);
  if (filtered.length === 0 && cache.length === 0) {
    return;
  }
  updateMetrics(filtered);
  refreshCharts(filtered, limits);
}

function clearCache() {
  cache.length = 0;
  alerts.length = 0;
  lastDataTs = null;
  lastSampleTs = null;
  lastFetchAt = null;
  lastSeenCounter = null;
  lastPayload = null;

  renderAlerts();
  resetMetrics();
  DriftMonitor.reset();
  resetChartBaselinesToDefault();
  _lastOverlayBaselineClass = null;
  _lastOverlayBaselineSource = null;

  const charts = [tempChart, accelChart, gyroChart, vibrationChart, accelXChart, accelYChart, accelZChart, gyroXChart, gyroYChart, gyroZChart];
  charts.forEach(chart => {
    chart.data.labels = [];
    chart.data.datasets.forEach(dataset => {
      dataset.data = [];
    });
    chart.update('none');
  });

  document.getElementById('tempValue').textContent = '--';
  const accelAxisXEl = document.getElementById('accelAxisX');
  const accelAxisYEl = document.getElementById('accelAxisY');
  const accelAxisZEl = document.getElementById('accelAxisZ');
  if (accelAxisXEl) accelAxisXEl.textContent = 'AX=--';
  if (accelAxisYEl) accelAxisYEl.textContent = 'AY=--';
  if (accelAxisZEl) accelAxisZEl.textContent = 'AZ=--';

  const gyroAxisXEl = document.getElementById('gyroAxisX');
  const gyroAxisYEl = document.getElementById('gyroAxisY');
  const gyroAxisZEl = document.getElementById('gyroAxisZ');
  if (gyroAxisXEl) gyroAxisXEl.textContent = 'GX=--';
  if (gyroAxisYEl) gyroAxisYEl.textContent = 'GY=--';
  if (gyroAxisZEl) gyroAxisZEl.textContent = 'GZ=--';
  document.getElementById('tempProgress').style.width = '0%';
  document.getElementById('accelMagProgress').style.width = '0%';
  document.getElementById('gyroMagProgress').style.width = '0%';
  document.getElementById('fanState').textContent = '--';
  document.getElementById('fanStateDetail').textContent = 'Aguardando dados';
  document.getElementById('severity').textContent = 'NONE';
  document.getElementById('severityMessage').textContent = 'Sistema normal';
  document.getElementById('lastUpdate').textContent = '--';
  // Update column layout elements
  const elIds = ['lastPayloadTimestamp', 'lastPayloadTemp', 'lastPayloadVib',
                 'lastPayloadAX', 'lastPayloadAY', 'lastPayloadAZ',
                 'lastPayloadGX', 'lastPayloadGY', 'lastPayloadGZ'];
  elIds.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '--'; });

  updateStatus(false);
}

function exportCsv() {
  if (!cache.length) {
    return;
  }
  const header = ['timestamp', 'temperature', 'vibration', 'vibration_dps', 'accel_x_g', 'accel_y_g', 'accel_z_g', 'gyro_x_dps', 'gyro_y_dps', 'gyro_z_dps', 'fan_state', 'collection_id', 'phase_marker', 'severity', 'message'];
  const rows = cache.map(item => [
    new Date(item.ts).toISOString(),
    item.temperature,
    item.vibration,
    item.vibration_dps ?? '',
    item.accel_x_g,
    item.accel_y_g,
    item.accel_z_g,
    item.gyro_x_dps,
    item.gyro_y_dps,
    item.gyro_z_dps,
    item.fan_state,
    item.collection_id,
    item.phase_marker,
    item.severity,
    item.message,
  ]);
  const csv = [header, ...rows].map(row => row.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ventilador_monitor.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function adjustUpdateRate(newRateHz) {
  if (!newRateHz || newRateHz <= 0 || newRateHz === currentDashboardRateHz) {
    return; // No change needed or invalid rate
  }

  console.log(`[Dashboard] Adjusting update rate from ${currentDashboardRateHz}Hz to ${newRateHz}Hz.`);

  // Clear the old interval
  if (dataFetchIntervalId) {
    clearInterval(dataFetchIntervalId);
  }

  // Set the new interval
  CONFIG.UPDATE_INTERVAL = 1000 / newRateHz;
  dataFetchIntervalId = setInterval(fetchLatest, CONFIG.UPDATE_INTERVAL);

  // Update the current rate and UI
  currentDashboardRateHz = newRateHz;
  const rateEl = document.getElementById('headerRate');
  if (rateEl) {
    rateEl.textContent = `@ ${newRateHz} Hz`;
  }
}

function computeDashboardPullRate(serverConfig) {
  const sendsPerSec = Number(serverConfig?.sends_per_sec);
  if (Number.isFinite(sendsPerSec) && sendsPerSec > 0) {
    // Poll a bit faster than ESP32 upload cadence, but keep sane limits.
    return Math.max(2, Math.min(20, Math.round(sendsPerSec * 2)));
  }

  // Legacy fallback when sends_per_sec is absent.
  const sampleRate = Number(serverConfig?.sample_rate);
  if (Number.isFinite(sampleRate) && sampleRate > 0 && sampleRate <= 20) {
    return Math.max(1, Math.min(20, Math.round(sampleRate)));
  }

  return null;
}

function applyServerConfig(serverConfig) {
  if (!serverConfig) return;
  lastServerConfig = serverConfig;
  const pollRate = computeDashboardPullRate(serverConfig);
  if (pollRate) {
    adjustUpdateRate(pollRate);
  }
}

// Busca apenas o último dado (para atualização rápida de status)
async function fetchLatest() {
  try {
    const response = await fetch(withDeviceId(CONFIG.API_ENDPOINT), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const responseData = await response.json();
    const payload = responseData.data;
    const serverConfig = responseData.config;

    // Adjust rate if needed
    applyServerConfig(serverConfig);

    const normalized = normalizePayload(payload);
    lastPayload = normalized;
    if (normalized.hasRealTimestamp) lastSampleTs = normalized.ts;
    lastFetchAt = getNow();
    const hasCounter = Number.isFinite(normalized.counter);
    const isNewSample = hasCounter
      ? normalized.counter !== lastSeenCounter
      : normalized.ts !== lastDataTs;

    if (isNewSample) {
      lastSeenCounter = hasCounter ? normalized.counter : lastSeenCounter;
    } else if (lastFetchAt == null) {
      // First successful fetch after reload; mark online even if sample is repeated
      lastFetchAt = getNow();
    }
    lastDataTs = normalized.ts;

    pushCache(normalized);
    updateStatus(isFresh());
    updateCards(normalized);
    updateAlerts(normalized);
    renderAll();
  } catch (err) {
    updateStatus(false);
    console.error('Falha ao buscar dados:', err);
  }
}

// Busca o histórico de dados (para preencher os gráficos)
async function fetchHistory() {
  if (!CONFIG.HISTORY_ENDPOINT) {
    return;
  }
  try {
    const url = withDeviceId(`${CONFIG.HISTORY_ENDPOINT}?mode=history&seconds=${CONFIG.HISTORY_SECONDS}`);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const responseData = await response.json();
    const payload = responseData.data;
    const serverConfig = responseData.config;

    // Adjust rate if needed
    applyServerConfig(serverConfig);

    if (!Array.isArray(payload)) {
      return;
    }
    payload.reverse().forEach(item => {
      pushCache(normalizePayload(item));
    });
    renderAll();
  } catch (err) {
    console.warn('Histórico não carregado:', err);
  }
}

function setTimeRange(rangeKey) {
  if (!rangeKey) return;
  document.querySelectorAll('.btn[data-range]').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.btn[data-range="${rangeKey}"]`);
  if (btn) btn.classList.add('active');
  CONFIG.TIME_RANGE = rangeKey;
  renderAll();
}

document.querySelectorAll('.btn[data-range]').forEach(btn => {
  btn.addEventListener('click', () => setTimeRange(btn.dataset.range));
});

function zoomTimeRange(direction) {
  const idx = TIME_RANGE_ZOOM_STEPS.indexOf(CONFIG.TIME_RANGE);
  if (idx < 0) return;
  const nextIdx = Math.max(0, Math.min(TIME_RANGE_ZOOM_STEPS.length - 1, idx + direction));
  setTimeRange(TIME_RANGE_ZOOM_STEPS[nextIdx]);
}

document.getElementById('btnXZoomIn')?.addEventListener('click', () => zoomTimeRange(-1));
document.getElementById('btnXZoomOut')?.addEventListener('click', () => zoomTimeRange(1));

document.querySelectorAll('[data-yzoom-target][data-yzoom]').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.yzoomTarget;
    const action = btn.dataset.yzoom;
    if (!target || !action) return;
    if (action === 'auto') {
      setYZoomAuto(target);
    } else {
      stepYZoom(target, action);
    }
  });
});

Object.keys(CHART_Y_ZOOM_PRESETS).forEach(syncYZoomUI);

document.getElementById('exportCsv').addEventListener('click', exportCsv);
document.getElementById('clearCache').addEventListener('click', clearCache);

document.querySelectorAll('.tab-button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// --- CONTROLES DE PLAYBACK (PAUSA / NAVEGAÇÃO) ---

function togglePause() {
  isPaused = !isPaused;
  const btn = document.getElementById('btnPause');

  if (btn) {
    if (isPaused) {
      pauseSnapshot = getNow();
      btn.innerHTML = '&#9658;'; // Símbolo de Play
      btn.classList.add('active');
      btn.title = "Retomar atualização em tempo real";
    } else {
      pauseSnapshot = null;
      btn.innerHTML = '&#10074;&#10074;'; // Símbolo de Pause
      btn.classList.remove('active');
      btn.title = "Pausar visualização";
    }
  }
  updateLiveButton();
  renderAll();
}

function panHistory(direction) {
  // direction: 1 = voltar (passado), -1 = avançar (futuro)
  let rangeMs = 30000; // padrão 30s
  if (CONFIG.TIME_RANGE === '1m') rangeMs = 60000;
  if (CONFIG.TIME_RANGE === '5m') rangeMs = 300000;
  if (CONFIG.TIME_RANGE === '10m') rangeMs = 600000;
  if (CONFIG.TIME_RANGE === '1h') rangeMs = 3600000;
  if (CONFIG.TIME_RANGE === '6h') rangeMs = 21600000;

  // Move 20% da janela atual a cada clique
  const step = rangeMs * 0.2;
  viewOffsetMs += step * direction;

  if (viewOffsetMs < 0) viewOffsetMs = 0;

  updateLiveButton();
  renderAll();
}

function resetToLive() {
  isPaused = false;
  pauseSnapshot = null;
  viewOffsetMs = 0;

  const btnPause = document.getElementById('btnPause');
  if (btnPause) {
    btnPause.innerHTML = '&#10074;&#10074;';
    btnPause.classList.remove('active');
  }

  updateLiveButton();
  renderAll();
}

function updateLiveButton() {
  const btnLive = document.getElementById('btnLive');
  if (!btnLive) return;

  const isLive = !isPaused && viewOffsetMs === 0;
  btnLive.style.display = isLive ? 'none' : 'inline-block';
}

// Mapping: chart stat strip ID -> axis key(s) in the baselines JSON
const REF_STRIP_AXIS_MAP = {
  accelXStats: { type: 'single', axis: 'accel_x_g' },
  accelYStats: { type: 'single', axis: 'accel_y_g' },
  accelZStats: { type: 'single', axis: 'accel_z_g' },
  gyroXStats:  { type: 'single', axis: 'gyro_x_dps' },
  gyroYStats:  { type: 'single', axis: 'gyro_y_dps' },
  gyroZStats:  { type: 'single', axis: 'gyro_z_dps' },
  accelMultiStats: {
    type: 'multi',
    axes: [
      { key: 'accel_x_g', label: 'X', cssClass: 'axis-x' },
      { key: 'accel_y_g', label: 'Y', cssClass: 'axis-y' },
      { key: 'accel_z_g', label: 'Z', cssClass: 'axis-z' },
    ],
  },
  gyroMultiStats: {
    type: 'multi',
    axes: [
      { key: 'gyro_x_dps', label: 'X', cssClass: 'gyro-axis-x' },
      { key: 'gyro_y_dps', label: 'Y', cssClass: 'gyro-axis-y' },
      { key: 'gyro_z_dps', label: 'Z', cssClass: 'gyro-axis-z' },
    ],
  },
};

let refBaselinesVisible = true;

function injectPerClassReferenceStrips() {
  const baselines = getActivePerClassBaselines();
  if (!baselines) return;
  const classes = Object.keys(baselines);
  const classLabels = {};
  classes.forEach(c => { classLabels[c] = 'REF ' + _classShort(c); });
  const fmt = (v) => Number.isFinite(v) ? v.toFixed(3) : '--';

  Object.entries(REF_STRIP_AXIS_MAP).forEach(([anchorId, config]) => {
    const anchor = document.getElementById(anchorId);
    if (!anchor) return;

    const storageKey = `iot_dashboard_ref_eda_open_${anchorId}`;
    const defaultOpen = false; // keep cards compact; user can expand when needed
    let initialOpen = defaultOpen;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === '1') initialOpen = true;
      if (raw === '0') initialOpen = false;
    } catch (e) {
      // ignore
    }

    const toggleId = anchorId + 'RefToggle';
    const groupId = anchorId + 'RefGroup';
    let toggleBtn = document.getElementById(toggleId);
    let group = document.getElementById(groupId);

    const isFirstRender = (!toggleBtn || !group);

    if (isFirstRender) {
      // Toggle button (collapsible)
      toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.id = toggleId;
      toggleBtn.className = 'ref-baselines-toggle';
      toggleBtn.setAttribute('aria-expanded', initialOpen ? 'true' : 'false');
      anchor.insertAdjacentElement('afterend', toggleBtn);

      // Group container
      group = document.createElement('div');
      group.className = 'ref-baselines-group';
      group.id = groupId;
      group.classList.toggle('hidden', !initialOpen);
      toggleBtn.insertAdjacentElement('afterend', group);

      // Toggle event + persistence
      toggleBtn.addEventListener('click', () => {
        const willOpen = group.classList.contains('hidden');
        group.classList.toggle('hidden', !willOpen);
        toggleBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        try {
          localStorage.setItem(storageKey, willOpen ? '1' : '0');
        } catch (e) {
          // ignore
        }
      });

      anchor.dataset.refPerClassInjected = 'true';
    }

    // Always re-render with the currently active baselines (e.g. after OL absorption).
    const label = getActiveBaselinesLabel();
    if (refBaselinesSource === 'adapted') {
      const meta = ADAPTED_PER_CLASS_BASELINES_META || {};
      const extra = [];
      if (meta.tag) extra.push(`tag=${meta.tag}`);
      if (meta.collection_id) extra.push(`col=${meta.collection_id}`);
      if (meta.configured_sample_rate_hz) extra.push(`hz=${meta.configured_sample_rate_hz}`);
      if (meta.generated_at) extra.push(`at=${meta.generated_at}`);
      toggleBtn.title = 'Mostrar/ocultar referências do modelo adaptado (Soak) por classe' + (extra.length ? ` | ${extra.join(' | ')}` : '');
    } else {
      toggleBtn.title = 'Mostrar/ocultar referências do treino (EDA) por classe';
    }
    toggleBtn.innerHTML = `<span class="ref-baselines-arrow">&#9654;</span> ${label}`;

    group.dataset.refSource = refBaselinesSource;
    group.innerHTML = '';

    classes.forEach(cls => {
      const classData = baselines[cls];
      if (!classData) return;

      if (config.type === 'single') {
        const axisData = classData[config.axis];
        if (!axisData) return;
        const strip = document.createElement('div');
        const cc = _classColor(cls);
        strip.className = 'chart-stat-strip chart-stat-strip-ref';
        strip.dataset.refClass = cls;
        strip.dataset.refAxis = config.axis;
        strip.style.borderColor = cc + '66';
        strip.style.background = cc + '0f';
        strip.innerHTML = `
          <span class="chart-stat-axis" style="color:${cc};border-color:${cc}66;background:${cc}1f;">${classLabels[cls]}</span>
          <span class="chart-stat" style="border-color:${cc}4d;background:${cc}0f;"><span class="chart-stat-label">RMS</span><span class="chart-stat-value">${fmt(axisData.rms)}</span></span>
          <span class="chart-stat" style="border-color:${cc}4d;background:${cc}0f;"><span class="chart-stat-label">Min</span><span class="chart-stat-value">${fmt(axisData.min)}</span></span>
          <span class="chart-stat" style="border-color:${cc}4d;background:${cc}0f;"><span class="chart-stat-label">Max</span><span class="chart-stat-value">${fmt(axisData.max)}</span></span>
          <span class="chart-stat" style="border-color:${cc}4d;background:${cc}0f;"><span class="chart-stat-label">Desvio</span><span class="chart-stat-value">${fmt(axisData.std)}</span></span>
        `;
        group.appendChild(strip);
      } else if (config.type === 'multi') {
        const strip = document.createElement('div');
        const cc = _classColor(cls);
        strip.className = 'chart-stat-strip chart-stat-strip-multi chart-stat-strip-ref';
        strip.style.borderColor = cc + '66';
        strip.style.background = cc + '0f';
        strip.dataset.refClass = cls;
        let rowsHtml = '';
        config.axes.forEach(({ key, label, cssClass }) => {
          const axisData = classData[key];
          if (!axisData) return;
          rowsHtml += `
            <div class="chart-stat-row">
              <span class="chart-stat-axis ${cssClass}">${label}</span>
              <span class="chart-stat-item ${cssClass}"><span class="chart-stat-label">RMS</span><span class="chart-stat-value">${fmt(axisData.rms)}</span></span>
              <span class="chart-stat-item ${cssClass}"><span class="chart-stat-label">Min</span><span class="chart-stat-value">${fmt(axisData.min)}</span></span>
              <span class="chart-stat-item ${cssClass}"><span class="chart-stat-label">Max</span><span class="chart-stat-value">${fmt(axisData.max)}</span></span>
              <span class="chart-stat-item ${cssClass}"><span class="chart-stat-label">Desvio</span><span class="chart-stat-value">${fmt(axisData.std)}</span></span>
            </div>`;
        });
        strip.innerHTML = `<div class="chart-stat-row"><span class="chart-stat-axis" style="color:${cc};border-color:${cc}66;background:${cc}1f;">${classLabels[cls]}</span></div>${rowsHtml}`;
        group.appendChild(strip);
      }
    });
  });
}

// Store latest computed stats for ref-match highlighting
let _latestAxisStats = {};

function updateRefMatchHighlight() {
  const baselines = getActivePerClassBaselines();
  if (!baselines) return;
  const classes = Object.keys(baselines);

  // For each single-axis chart, find the closest reference class by std deviation
  Object.entries(REF_STRIP_AXIS_MAP).forEach(([anchorId, config]) => {
    const group = document.getElementById(anchorId + 'RefGroup');
    if (!group) return;

    if (config.type === 'single') {
      const currentStd = _latestAxisStats[config.axis]?.std;
      if (!Number.isFinite(currentStd)) {
        group.querySelectorAll('.ref-match').forEach(el => el.classList.remove('ref-match'));
        return;
      }

      let bestClass = null;
      let bestDist = Infinity;
      classes.forEach(cls => {
        const refStd = baselines[cls]?.[config.axis]?.std;
        if (!Number.isFinite(refStd)) return;
        const dist = Math.abs(currentStd - refStd);
        if (dist < bestDist) { bestDist = dist; bestClass = cls; }
      });

      group.querySelectorAll('[data-ref-class]').forEach(strip => {
        strip.classList.toggle('ref-match', strip.dataset.refClass === bestClass);
      });
    } else if (config.type === 'multi') {
      // Average normalized distance across axes
      let bestClass = null;
      let bestScore = Infinity;
      classes.forEach(cls => {
        let totalDist = 0;
        let count = 0;
        config.axes.forEach(({ key }) => {
          const currentStd = _latestAxisStats[key]?.std;
          const refStd = baselines[cls]?.[key]?.std;
          if (Number.isFinite(currentStd) && Number.isFinite(refStd) && refStd > 0) {
            totalDist += Math.abs(currentStd - refStd) / refStd;
            count++;
          }
        });
        if (count > 0) {
          const avg = totalDist / count;
          if (avg < bestScore) { bestScore = avg; bestClass = cls; }
        }
      });

      group.querySelectorAll('[data-ref-class]').forEach(strip => {
        strip.classList.toggle('ref-match', strip.dataset.refClass === bestClass);
      });
    }
  });
}

// Cria os botões de controle de playback dinamicamente
function injectPlaybackControls() {
  const rangeBtn = document.querySelector('.btn[data-range]');
  if (!rangeBtn || !rangeBtn.parentElement) return;

  const container = rangeBtn.parentElement;

  // Separador
  const sep = document.createElement('span');
  sep.style.borderLeft = '1px solid #cbd5e1';
  sep.style.margin = '0 8px';
  sep.style.height = '20px';
  sep.style.display = 'inline-block';
  sep.style.verticalAlign = 'middle';
  container.appendChild(sep);

  // Botões
  const createBtn = (html, title, onClick, id) => {
    const btn = document.createElement('button');
    btn.className = 'btn';
    if (id) btn.id = id;
    btn.innerHTML = html;
    btn.title = title;
    btn.onclick = onClick;
    container.appendChild(btn);
    return btn;
  };

  createBtn('&#9664;', "Voltar (Passado)", () => panHistory(1));
  createBtn('&#10074;&#10074;', "Pausar", togglePause, 'btnPause');
  createBtn('&#9654;', "Avançar (Futuro)", () => panHistory(-1));

  const btnLive = createBtn('AO VIVO', "Voltar para o tempo real", resetToLive, 'btnLive');
  btnLive.style.display = 'none';
  btnLive.style.color = '#ef4444';
  btnLive.style.fontWeight = 'bold';
  btnLive.style.marginLeft = '5px';
}

// Defer data fetching until ML classifier is initialized
// This ensures historical data can be fed to the classifier

let dataFetchingStarted = false;

// Inicia o loop de busca de dados APÓS o ML estar pronto
async function startDataFetching() {
  if (dataFetchingStarted) return;
  dataFetchingStarted = true;

  console.log('[Dashboard] Starting data fetching after ML initialization');
  await fetchHistory();
  dataFetchIntervalId = setInterval(fetchLatest, CONFIG.UPDATE_INTERVAL);
}

// Will be called after ML initialization

// =============================================================================
// ML CLASSIFICATION INTEGRATION
// =============================================================================

const ML_CONFIG = {
  MODEL_INDEX_URL: '../models/MODEL_INDEX.json',   // Map sample_rate -> model
  MODEL_URL: 'models/gnb_model_20260223.json',  // Modelo primario GNB 7-class 100Hz (100% CV)
  PREDICTION_INTERVAL: 200,                      // Predicao a cada 200ms (5Hz)
  ENABLED: true,                                 // ML classification enabled by default
};

let mlPredictionInterval = null;
let mlInitialized = false;
let mlModelIndex = null;
let mlModelUrl = ML_CONFIG.MODEL_URL;
let mlModelRate = null;
let mlModelLoading = false;

function normalizeRate(rate) {
  if (!Number.isFinite(rate)) return null;
  return String(Math.round(rate));
}

async function loadModelIndex() {
  if (!ML_CONFIG.MODEL_INDEX_URL) return null;
  try {
    const response = await fetch(ML_CONFIG.MODEL_INDEX_URL, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    // Some JSON files may be saved with UTF-8 BOM. fetch().json() uses JSON.parse,
    // which can choke on the BOM char. Parse from text and strip BOM explicitly.
    const rawText = await response.text();
    const cleanText = rawText.replace(/^\uFEFF/, '');
    const indexData = JSON.parse(cleanText);
    mlModelIndex = indexData;
    return indexData;
  } catch (err) {
    console.warn('[ML] MODEL_INDEX.json nao encontrado ou invalido:', err.message);
    return null;
  }
}

function resolveModelUrl(sampleRate) {
  const rateKey = normalizeRate(sampleRate);
  if (mlModelIndex && rateKey && mlModelIndex.models_by_rate && mlModelIndex.models_by_rate[rateKey]) {
    return mlModelIndex.models_by_rate[rateKey];
  }
  if (mlModelIndex && mlModelIndex.default_model) {
    return mlModelIndex.default_model;
  }
  return ML_CONFIG.MODEL_URL;
}

async function loadModelFromUrl(url, rateKey = null, allowFallback = true) {
  if (mlModelLoading) return false;
  mlModelLoading = true;
  updateMLBadge('loading', 'Carregando...');

  let loaded = false;
  try {
    // Reset adapted baselines state for a clean switch between model files.
    clearAdaptedPerClassBaselines();
    injectPerClassReferenceStrips();
    updateRefMatchHighlight();

    console.log(`[ML] Trying to load model from: ${url}`);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const modelData = await response.json();
    if (window.fanClassifier && window.fanClassifier.isReady) {
      window.fanClassifier.reset();
    }
    loaded = await window.fanClassifier.init(modelData);
    if (loaded) {
      mlErrorState = null;
      mlModelUrl = url;
      mlModelRate = rateKey;
      window.mlModelData = modelData;
      updateModelPerformance(modelData);
      buildModelFeatureList(modelData);
      buildMLFeatureRows(modelData);
      console.log(`[ML] Model loaded successfully from: ${url}`);
      if (modelData.eda_traceability) {
        const eda = modelData.eda_traceability;
        console.log(`[ML] EDA traceability: id=${eda.eda_id}, config=v${eda.feature_config_version}, rate=${eda.sample_rate_hz}Hz, features=${eda.features_count}`);
      }

      // Populate Soak Test sequence field with model labels
      const seqInput = document.getElementById('stCfgSequence');
      if (seqInput && !seqInput.value) {
        seqInput.value = _getModelLabels().join(',');
      }

      // Reset health check for fresh model evaluation
      ModelHealthCheck.reset();
      DriftMonitor.reset();

      // Online Learning: check for adapted model in localStorage
      const adaptedModel = OnlineLearning.initialize(modelData);
      if (adaptedModel) {
        await window.fanClassifier.init(adaptedModel);
        window.mlModelData = adaptedModel;
        OnlineLearning.isAdapted = true;
        updateModelPerformance(adaptedModel);
        buildModelFeatureList(adaptedModel);
        buildMLFeatureRows(adaptedModel);
        // Prefer baselines stored inside the adapted model (derived from Soak).
        setAdaptedPerClassBaselinesFromModel(adaptedModel);
        injectPerClassReferenceStrips();
        updateRefMatchHighlight();
        console.log('[ML] Using adapted model from localStorage');
      }
      OnlineLearning._updateBadge();
      OnlineLearning._updateHistoryInfo();
    }
  } catch (err) {
    console.error(`[ML] Failed to load model from ${url}:`, err.message);
    if (allowFallback && url !== ML_CONFIG.MODEL_URL) {
      console.warn('[ML] Falling back to default model URL.');
      loaded = await loadModelFromUrl(ML_CONFIG.MODEL_URL, null, false);
    }
  } finally {
    mlModelLoading = false;
  }

  return loaded;
}

function ensureModelForRate(sampleRate) {
  if (!ML_CONFIG.ENABLED || !window.fanClassifier) return;
  if (mlModelLoading) return;
  const rateKey = normalizeRate(sampleRate);
  if (!rateKey) return;
  const targetUrl = resolveModelUrl(sampleRate);
  if (targetUrl === mlModelUrl) return;
  loadModelFromUrl(targetUrl, rateKey, true);
}

/**
 * Inicializa o classificador ML carregando o arquivo JSON do modelo
 */
async function initMLClassifier() {
  if (mlInitialized) {
    console.log('[ML] Already initialized, skipping');
    return window.fanClassifier?.isReady || false;
  }

  if (typeof window.fanClassifier === 'undefined') {
    console.warn('[ML] Classifier module not loaded');
    mlErrorState = 'Módulo não carregado';
    updateMLUI({ status: 'error', message: 'Módulo não carregado' });
    return false;
  }

  updateMLBadge('loading', 'Carregando...');

  await loadModelIndex();
  const initialRate = lastServerConfig?.sample_rate ?? null;
  const initialUrl = resolveModelUrl(initialRate);
  const loaded = await loadModelFromUrl(initialUrl, normalizeRate(initialRate), true);

  if (loaded) {
    mlInitialized = true;
    syncMLBadgeState();
    updateMLDecisionMeta();
    const info = window.fanClassifier.getModelInfo();
    console.log('[ML] Model info:', info);

    // Start prediction loop
    startMLPredictionLoop();

    // Set callback for predictions
    window.fanClassifier.onPrediction = (prediction) => {
      updateMLUI(prediction);
      ModelHealthCheck.onPrediction(prediction);
      DriftMonitor.onPrediction(prediction);
    };

    // Set callback for transitions (log + persist)
    window.fanClassifier.onTransition = (entry) => {
      updateTransitionUI(entry);
      persistTransitionLog(entry);
    };

    return true;
  } else {
    mlErrorState = 'Modelo não carregado';
    updateMLBadge('error', 'Modelo não encontrado');
    updateMLUI({ status: 'error', message: 'Modelo não carregado' });
    return false;
  }
}

/**
 * Update ML badge status
 */
function updateMLBadge(status, text) {
  const badge = document.getElementById('mlBadge');
  if (!badge) return;

  badge.className = 'ml-badge';
  switch (status) {
    case 'active':
      badge.classList.add('ml-badge-active');
      break;
    case 'loading':
      badge.classList.add('ml-badge-loading');
      break;
    case 'error':
      badge.classList.add('ml-badge-error');
      break;
    case 'offline':
      badge.classList.add('ml-badge-offline');
      break;
  }
  badge.textContent = text;
}

function syncMLBadgeState() {
  if (mlErrorState) {
    updateMLBadge('error', mlErrorState);
    return;
  }
  if (!mlDataOnline) {
    updateMLBadge('offline', 'Sem dados');
    return;
  }
  if (!ML_CONFIG.ENABLED) {
    updateMLBadge('loading', 'Pausado');
    return;
  }
  if (window.fanClassifier && window.fanClassifier.isReady) {
    updateMLBadge('active', 'ML Ativo');
    return;
  }
  updateMLBadge('loading', 'Carregando...');
}

function setMLDataOnline(isOnline) {
  if (mlDataOnline === isOnline) return;
  mlDataOnline = isOnline;

  if (!isOnline) {
    stopMLPredictionLoop();
    if (!mlErrorState) {
      updateMLUI({ status: 'offline' });
    }
    syncMLBadgeState();
    return;
  }

  if (ML_CONFIG.ENABLED && window.fanClassifier && window.fanClassifier.isReady) {
    startMLPredictionLoop();
  }
  syncMLBadgeState();
}

function setTextById(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
  }
}

function updateMLDecisionMeta() {
  if (!window.ClassifierConfig) return;
  const alpha = window.ClassifierConfig.SMOOTHING_ALPHA;
  setTextById('mlAlpha', alpha != null ? alpha.toFixed(2) : '--');
  setTextById('mlWindowSize', window.ClassifierConfig.WINDOW_SIZE ?? '--');
  setTextById('mlMinPoints', window.ClassifierConfig.MIN_POINTS ?? '--');
}

function updateModelPerformance(modelData) {
  if (!modelData) return;

  const metrics = modelData.metrics || {};
  const cvMean = metrics.cv_accuracy_mean;
  const trainAcc = metrics.train_accuracy;
  const holdoutAcc = metrics.holdout_test?.accuracy ?? null;
  const lowMedConf = metrics.cv?.stratified?.low_med_confusion_rate ?? null;

  setTextById('modelCvAccuracy', cvMean != null ? (cvMean * 100).toFixed(2) + '%' : '--');
  setTextById('modelTrainAccuracy', trainAcc != null ? (trainAcc * 100).toFixed(2) + '%' : '--');
  setTextById('modelHoldoutAccuracy', holdoutAcc != null ? (holdoutAcc * 100).toFixed(2) + '%' : '--');
  setTextById('modelLowMedConfusionRate', lowMedConf != null ? (lowMedConf * 100).toFixed(2) + '%' : '--');

  const featureCount = modelData.feature_count || (Array.isArray(modelData.features) ? modelData.features.length : null);
  const totalSamples = modelData.training_info?.total_samples;

  setTextById('modelFeatureCount', featureCount != null ? featureCount : '--');
  setTextById('modelFeatureCountSummary', featureCount != null ? featureCount : '--');
  setTextById('modelWindowCount', totalSamples != null ? totalSamples : '--');

  let validation = '5-Fold CV';
  if (holdoutAcc != null) validation += ' + Holdout';
  setTextById('modelValidation', validation);

  // EDA traceability
  const eda = modelData.eda_traceability || null;
  if (eda) {
    setTextById('modelEdaVersion', `v${eda.feature_config_version || '?'}`);
    setTextById('modelEdaId', eda.eda_id || '?');
    setTextById('modelFeId', eda.fe_id || '--');
    setTextById('modelSelectionMethod', eda.selection_method || '--');
    setTextById('modelFeaturesCsvFile', eda.features_csv_file || '--');
    setTextById('modelFeaturesCsvHash', eda.features_csv_hash ? String(eda.features_csv_hash) : '--');
  } else {
    setTextById('modelEdaVersion', '--');
    setTextById('modelEdaId', '--');
    setTextById('modelFeId', '--');
    setTextById('modelSelectionMethod', '--');
    setTextById('modelFeaturesCsvFile', '--');
    setTextById('modelFeaturesCsvHash', '--');
  }

  const modelRate = modelData.sample_rate_hz || modelData.training_info?.sample_rate_hz || eda?.sample_rate_hz;
  setTextById('modelSampleRate', modelRate != null ? `${modelRate} Hz` : '--');

  setTextById('modelVersion', modelData.version || '--');
  setTextById('modelGeneratedBy', modelData.generated_by || '--');
  setTextById('modelGeneratedAt', modelData.generated_at || '--');
  setTextById('modelType', modelData.type || '--');
  setTextById('modelLabels', Array.isArray(modelData.labels) ? modelData.labels.join(', ') : '--');
  setTextById('modelFile', (typeof mlModelUrl !== 'undefined' && mlModelUrl) ? mlModelUrl : (ML_CONFIG?.MODEL_URL || '--'));

  const windowSize = modelData.training_info?.window_size;
  const stepSize = modelData.training_info?.step_size;
  setTextById(
    'modelWindowInfo',
    (windowSize != null || stepSize != null) ? `${windowSize ?? '?'} / ${stepSize ?? '?'}` : '--'
  );

  const noteEl = document.getElementById('modelNote');
  if (noteEl) {
    noteEl.innerHTML = '';
    const strong = document.createElement('strong');
    const algo = (modelData.type === 'softmax_logreg') ? 'Softmax LR' : 'GNB';
    strong.textContent = algo;
    noteEl.appendChild(strong);

    const parts = [
      (featureCount != null) ? `${featureCount} feats` : null,
      (cvMean != null) ? `CV ${(cvMean * 100).toFixed(1)}%` : null,
      (holdoutAcc != null) ? `Holdout ${(holdoutAcc * 100).toFixed(1)}%` : null,
      (lowMedConf != null) ? `L<->M ${(lowMedConf * 100).toFixed(1)}%` : null,
    ].filter(Boolean);

    if (parts.length) {
      noteEl.appendChild(document.createTextNode(' | ' + parts.join(' | ')));
    }

    if (eda?.selection_method) {
      noteEl.title = `Selecao: ${eda.selection_method}`;
    } else {
      noteEl.removeAttribute('title');
    }
  }

  // Also update the "Model Feature Params" reference panel (reflects OL changes).
  updateModelFeatureParams(modelData);
}

// =============================================================================
// MODEL REFERENCE (FEATURE PARAMS)
// =============================================================================

let _modelParamsSelectedClass = null;
let _modelParamsLastModel = null;
let _modelParamsInited = false;

function initModelParamsUI() {
  if (_modelParamsInited) return;
  _modelParamsInited = true;
  const sel = document.getElementById('modelParamsClassSelect');
  if (!sel) return;

  try {
    const raw = localStorage.getItem('iot_model_params_class');
    if (raw) _modelParamsSelectedClass = raw;
  } catch (e) {
    // ignore
  }

  sel.addEventListener('change', () => {
    _modelParamsSelectedClass = sel.value;
    try {
      localStorage.setItem('iot_model_params_class', _modelParamsSelectedClass);
    } catch (e) {
      // ignore
    }
    renderModelFeatureParams();
  });

  // Initial render (shows placeholder until the model loads).
  renderModelFeatureParams();
}

function updateModelFeatureParams(modelData) {
  _modelParamsLastModel = modelData || null;
  renderModelFeatureParams();
}

function renderModelFeatureParams() {
  const wrap = document.getElementById('modelParamsTableWrap');
  const metaEl = document.getElementById('modelParamsMeta');
  const summaryEl = document.getElementById('modelParamsSummary');
  const sel = document.getElementById('modelParamsClassSelect');

  if (!wrap || !summaryEl) return;

  const modelData = _modelParamsLastModel || window.mlModelData;
  if (!modelData) {
    wrap.innerHTML = '<div class="model-params-empty">Modelo não carregado.</div>';
    summaryEl.textContent = '';
    if (metaEl) metaEl.textContent = '';
    return;
  }

  const labels = Array.isArray(modelData.labels) ? modelData.labels : _getModelLabels();
  // Populate dropdown dynamically
  if (sel) {
    const existingOpts = Array.from(sel.options).map(o => o.value);
    if (existingOpts.join(',') !== labels.join(',')) {
      sel.innerHTML = '';
      labels.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l;
        opt.textContent = _classShort(l);
        sel.appendChild(opt);
      });
    }
  }
  let cls = _modelParamsSelectedClass;
  if (!cls || !labels.includes(cls)) cls = labels[0];
  _modelParamsSelectedClass = cls;
  if (sel) sel.value = cls;

  const isAdapted = !!(modelData._adapted || OnlineLearning?.isAdapted);
  if (metaEl) metaEl.textContent = isAdapted ? 'Adaptado' : 'Base';

  const stats = modelData.stats;
  const features = Array.isArray(modelData.features) ? modelData.features : [];
  const curClassStats = stats && typeof stats === 'object' ? stats[cls] : null;
  if (!curClassStats || typeof curClassStats !== 'object') {
    wrap.innerHTML = `<div class="model-params-empty">Sem estatísticas para a classe ${escapeHtml(cls)}.</div>`;
    summaryEl.textContent = '';
    return;
  }

  const baseStats = OnlineLearning?.baseModel?.stats;
  const baseClassStats = (baseStats && typeof baseStats === 'object' && baseStats[cls] && typeof baseStats[cls] === 'object')
    ? baseStats[cls]
    : null;
  const canCompare = isAdapted && !!baseClassStats;

  const fmt = (v) => Number.isFinite(v) ? v.toFixed(4) : '--';
  const fmtCount = (v) => Number.isFinite(v) ? String(Math.round(v)) : '--';

  let comparableN = 0;
  let over10 = 0;
  let over25 = 0;
  let maxAbsDelta = null;

  const rows = [];
  for (const feat of features) {
    const cur = curClassStats[feat];
    const meanCur = cur?.mean;
    const stdCur = Number.isFinite(cur?.var) ? Math.sqrt(Math.max(0, cur.var)) : null;
    const countCur = cur?.count;

    if (!canCompare) {
      rows.push(`
        <tr>
          <td class="model-params-feature">${escapeHtml(feat)}</td>
          <td>${fmt(meanCur)}</td>
          <td>${fmt(stdCur)}</td>
          <td>${fmtCount(countCur)}</td>
        </tr>
      `);
      continue;
    }

    const base = baseClassStats ? baseClassStats[feat] : null;
    const meanBase = base?.mean;
    const stdBase = Number.isFinite(base?.var) ? Math.sqrt(Math.max(0, base.var)) : null;
    const countBase = base?.count;

    let deltaMeanPct = null;
    if (Number.isFinite(meanBase) && Number.isFinite(meanCur) && meanBase !== 0) {
      deltaMeanPct = ((meanCur - meanBase) / Math.abs(meanBase)) * 100;
    }
    if (deltaMeanPct != null) {
      comparableN += 1;
      const abs = Math.abs(deltaMeanPct);
      if (maxAbsDelta == null || abs > maxAbsDelta) maxAbsDelta = abs;
      if (abs > 10) over10 += 1;
      if (abs > 25) over25 += 1;
    }

    let deltaClass = 'ok';
    if (deltaMeanPct == null) deltaClass = 'ok';
    else if (Math.abs(deltaMeanPct) > 25) deltaClass = 'bad';
    else if (Math.abs(deltaMeanPct) > 10) deltaClass = 'warn';

    const deltaText = (deltaMeanPct == null)
      ? '--'
      : `${deltaMeanPct >= 0 ? '+' : ''}${deltaMeanPct.toFixed(1)}%`;

    rows.push(`
      <tr>
        <td class="model-params-feature">${escapeHtml(feat)}</td>
        <td>
          <span class="model-params-base">${fmt(meanBase)}</span>
          <span class="model-params-arrow">&rarr;</span>
          <span>${fmt(meanCur)}</span>
        </td>
        <td>
          <span class="model-params-base">${fmt(stdBase)}</span>
          <span class="model-params-arrow">&rarr;</span>
          <span>${fmt(stdCur)}</span>
        </td>
        <td>
          <span class="model-params-base">${fmtCount(countBase)}</span>
          <span class="model-params-arrow">&rarr;</span>
          <span>${fmtCount(countCur)}</span>
        </td>
        <td class="model-params-delta ${deltaClass}">${escapeHtml(deltaText)}</td>
      </tr>
    `);
  }

  if (canCompare) {
    const maxTxt = (maxAbsDelta != null) ? maxAbsDelta.toFixed(1) + '%' : '--';
    summaryEl.textContent = `Classe ${cls}: ${features.length} feats | max Δmean: ${maxTxt} | >10%: ${over10}/${comparableN} | >25%: ${over25}/${comparableN}`;
  } else {
    const tag = isAdapted ? 'adaptado' : 'base';
    summaryEl.textContent = `Classe ${cls}: ${features.length} feats (modelo ${tag})`;
  }

  const head = canCompare
    ? `<tr>
        <th>Feature</th>
        <th>Mean (base&rarr;atual)</th>
        <th>Std (base&rarr;atual)</th>
        <th>Count (base&rarr;atual)</th>
        <th style="text-align:right;">Δmean%</th>
      </tr>`
    : `<tr>
        <th>Feature</th>
        <th>Mean</th>
        <th>Std</th>
        <th>Count</th>
      </tr>`;

  wrap.innerHTML = `
    <table class="model-params-table">
      <thead>${head}</thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  `;
}

function buildModelFeatureList(modelData) {
  const listEl = document.getElementById('modelFeatureList');
  if (!listEl || !modelData?.features) return;
  listEl.innerHTML = '';
  modelData.features.forEach(feature => {
    const tag = document.createElement('span');
    tag.className = 'model-feature-tag';
    tag.textContent = feature;
    listEl.appendChild(tag);
  });
}

const FEATURES_PER_PAGE = 5;
let mlFeaturePage = 0;
let mlAllFeatures = [];

function buildMLFeatureRows(modelData) {
  const listEl = document.getElementById('mlFeatureList');
  const selectEl = document.getElementById('mlFeaturePageSelect');
  if (!listEl || !modelData?.features) return;

  mlAllFeatures = modelData.features;
  const totalPages = Math.ceil(mlAllFeatures.length / FEATURES_PER_PAGE);

  // Build dropdown
  if (selectEl) {
    selectEl.innerHTML = '';
    for (let i = 0; i < totalPages; i++) {
      const start = i * FEATURES_PER_PAGE + 1;
      const end = Math.min((i + 1) * FEATURES_PER_PAGE, mlAllFeatures.length);
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${start}–${end} de ${mlAllFeatures.length}`;
      selectEl.appendChild(opt);
    }
    selectEl.addEventListener('change', () => {
      mlFeaturePage = Number(selectEl.value);
      renderFeaturePage();
    });
  }

  mlFeaturePage = 0;
  renderFeaturePage();
}

function renderFeaturePage() {
  const listEl = document.getElementById('mlFeatureList');
  if (!listEl) return;
  listEl.innerHTML = '';
  const start = mlFeaturePage * FEATURES_PER_PAGE;
  const pageFeatures = mlAllFeatures.slice(start, start + FEATURES_PER_PAGE);
  pageFeatures.forEach(feature => {
    const row = document.createElement('div');
    row.className = 'ml-feature-row';
    row.dataset.feature = feature;
    row.innerHTML = `
      <span class="ml-feature-name">${feature}</span>
      <span class="ml-feature-value">--</span>
      <span class="ml-feature-class">--</span>
    `;
    listEl.appendChild(row);
  });
}

function formatFeatureValue(value) {
  if (value == null || Number.isNaN(value)) {
    return '--';
  }
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 10) return value.toFixed(2);
  return value.toFixed(3);
}

function getClosestLabel(feature, value) {
  const modelData = window.mlModelData;
  if (!modelData?.stats || value == null || Number.isNaN(value)) return null;
  let bestLabel = null;
  let bestDiff = Infinity;
  (modelData.labels || []).forEach(label => {
    const mean = modelData.stats?.[label]?.[feature]?.mean;
    if (mean == null) return;
    const diff = Math.abs(value - mean);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestLabel = label;
    }
  });
  return bestLabel;
}

function updateFeatureRows(prediction) {
  const listEl = document.getElementById('mlFeatureList');
  if (!listEl || !prediction?.features) return;

  const rows = listEl.querySelectorAll('.ml-feature-row');
  rows.forEach(row => {
    const feature = row.dataset.feature;
    const value = prediction.features[feature];
    const valueEl = row.querySelector('.ml-feature-value');
    const classEl = row.querySelector('.ml-feature-class');

    valueEl.textContent = formatFeatureValue(value);

    const closest = getClosestLabel(feature, value);
    classEl.className = 'ml-feature-class';
    row.style.borderColor = '';
    classEl.style.color = '';

    if (closest) {
      classEl.textContent = `Tendência: ${_classShort(closest)}`;
      const cc = _classColor(closest);
      row.style.borderColor = cc + '59';
      classEl.style.color = cc;
    } else {
      classEl.textContent = 'Tendência: --';
    }
  });
}

/**
 * Reseta o estado do classificador de forma inteligente quando o modo é alterado externamente.
 */
function smartResetClassifier() {
  if (window.fanClassifier) {
    console.log('[ML] Smart Reset: Limpando buffer do classificador devido à mudança de modo.');
    window.fanClassifier.reset();
    DriftMonitor.reset();
    // Reseta contadores internos para aceitar novos dados imediatamente
    lastMLFeedTs = null;
    lastMLFeedCounter = null;
  }
}

function resetFeatureRows() {
  const listEl = document.getElementById('mlFeatureList');
  if (!listEl) return;
  const rows = listEl.querySelectorAll('.ml-feature-row');
  rows.forEach(row => {
    const valueEl = row.querySelector('.ml-feature-value');
    const classEl = row.querySelector('.ml-feature-class');
    classEl.className = 'ml-feature-class';
    row.style.borderColor = '';
    classEl.style.color = '';
    valueEl.textContent = '--';
    classEl.textContent = '--';
  });
}

function resetMLDecisionUI(statusText) {
  setTextById('mlRawPrediction', statusText);
  setTextById('mlRawConfidence', '--');
  setTextById('mlSmoothedPrediction', statusText);
  setTextById('mlSmoothedConfidence', '--');
  // Reset dynamic probability items
  _getModelLabels().forEach(lbl => {
    setTextById(`mlProb_${lbl}_raw`, '--');
    setTextById(`mlProb_${lbl}_smooth`, '--');
  });
  setTextById('mlHysteresisConfirmed', '--');
  setTextById('mlHysteresisCandidate', '--');
  setTextById('mlHysteresisCount', '--');
  resetFeatureRows();
}

/**
 * Atualiza a interface do usuário com os resultados do ML
 */
function updateMLUI(prediction) {
  const predEl = document.getElementById('mlPrediction');
  const confText = document.getElementById('mlConfidenceText');
  const confBar = document.getElementById('mlConfidenceBar');
  const bufferStatus = document.getElementById('mlBufferStatus');
  const stabilityEl = document.getElementById('mlStability');

  if (!predEl) return;

  // Handle different statuses
  if (prediction.status === 'error') {
    mlErrorState = prediction.message || 'Erro no classificador';
    predEl.textContent = 'ERRO';
    predEl.className = 'ml-prediction unknown';
    confText.textContent = prediction.message || 'Erro no classificador';
    confBar.style.width = '0%';
    resetMLDecisionUI('ERRO');
    syncMLBadgeState();
    return;
  }

  const hadError = !!mlErrorState;
  mlErrorState = null;
  if (hadError) {
    syncMLBadgeState();
  }

  if (prediction.status === 'offline') {
    predEl.textContent = 'SEM DADOS';
    predEl.className = 'ml-prediction unknown';
    const lastSeen = lastDataTs ? new Date(lastDataTs).toLocaleString('pt-BR') : null;
    confText.textContent = lastSeen
      ? `Sem dados em tempo real • Último: ${lastSeen}`
      : 'Aguardando dados do sensor';
    confBar.style.width = '0%';
    confBar.className = 'confidence-fill';
    confBar.style.background = 'linear-gradient(90deg, #ff5252, #ff9800)';
    bufferStatus.textContent = 'Buffer: --';
    stabilityEl.textContent = 'Estabilidade: --';
    resetMLDecisionUI('SEM DADOS');
    return;
  }

  if (!mlDataOnline) {
    return;
  }

  if (prediction.status === 'buffering') {
    predEl.textContent = 'COLETANDO...';
    predEl.className = 'ml-prediction buffering';
    confText.textContent = prediction.message;
    confBar.style.width = (prediction.bufferProgress * 100) + '%';
    confBar.className = 'confidence-fill';
    confBar.style.background = 'linear-gradient(90deg, #ffc107, #ff9800)';
    bufferStatus.textContent = `Buffer: ${Math.round(prediction.bufferProgress * 100)}%`;
    resetMLDecisionUI('COLETANDO');
    // Update main fan state card during buffering
    updateFanStateFromML('ANALISANDO', 'Coletando dados para classificação...', 'buffering');
    return;
  }

  // Normal prediction — trigger health check if not yet run
  if (!ModelHealthCheck._displayed && !ModelHealthCheck._collecting) {
    ModelHealthCheck.start();
  }

  predEl.textContent = _classShort(prediction.prediction);
  predEl.className = 'ml-prediction';
  predEl.style.color = _classColor(prediction.prediction);
  predEl.style.textShadow = `0 0 20px ${_classColor(prediction.prediction)}80`;

  // Confidence display
  const confPct = (prediction.confidence * 100).toFixed(1);
  confText.textContent = `Confiança: ${confPct}%`;
  confBar.style.width = confPct + '%';
  confBar.className = 'confidence-fill';
  if (prediction.confidenceLevel === 'high') {
    confBar.style.background = 'linear-gradient(90deg, #00ff88, #00d9ff)';
  } else if (prediction.confidenceLevel === 'medium') {
    confBar.style.background = 'linear-gradient(90deg, #ffc107, #ff9800)';
  } else {
    confBar.style.background = 'linear-gradient(90deg, #ff5252, #ff9800)';
  }

  // Buffer and stability
  bufferStatus.textContent = `Buffer: ${prediction.bufferSize || 0} pts`;
  if (window.fanClassifier) {
    const stability = window.fanClassifier.getStability();
    stabilityEl.textContent = `Estabilidade: ${(stability * 100).toFixed(0)}%`;
  }

  // Probabilities — dynamic for N classes
  const labels = _getModelLabels();
  if (prediction.smoothedProbabilities) {
    const probContainer = document.getElementById('mlProbContainer');
    if (probContainer) {
      _ensureProbItems(probContainer, labels, 'smooth');
      labels.forEach(lbl => {
        const val = ((prediction.smoothedProbabilities[lbl] || 0) * 100).toFixed(1);
        const el = document.getElementById(`mlProb_${lbl}_smooth`);
        if (el) {
          el.textContent = val + '%';
          el.className = 'ml-prob-value' + (prediction.prediction === lbl ? ' active' : '');
        }
      });
    }
  }

  // Raw probabilities — dynamic
  if (prediction.probabilities) {
    const rawContainer = document.getElementById('mlProbRawContainer');
    if (rawContainer) {
      _ensureProbItems(rawContainer, labels, 'raw');
      labels.forEach(lbl => {
        const val = ((prediction.probabilities[lbl] || 0) * 100).toFixed(1);
        const el = document.getElementById(`mlProb_${lbl}_raw`);
        if (el) el.textContent = val + '%';
      });
    }
  }

  // Decision card predictions
  const rawConfPct = ((prediction.rawConfidence || 0) * 100).toFixed(1);
  setTextById('mlRawPrediction', prediction.rawPrediction || '--');
  setTextById('mlRawConfidence', rawConfPct + '%');
  setTextById('mlSmoothedPrediction', prediction.prediction || '--');
  setTextById('mlSmoothedConfidence', confPct + '%');

  // Hysteresis status
  const hysteresisTarget = prediction.hysteresisCount || window.ClassifierConfig?.HYSTERESIS_COUNT || 0;
  const candidateCount = prediction.candidateCount ?? 0;
  setTextById('mlHysteresisConfirmed', prediction.confirmedState || '--');
  setTextById('mlHysteresisCandidate', prediction.candidateState || '--');
  setTextById('mlHysteresisCount', `${candidateCount}/${hysteresisTarget}`);

  // Feature values (real-time)
  updateFeatureRows(prediction);

  // Transition tracking
  updateTransitionMeta(prediction);

  // Update main fan state card with ML prediction
  const stateDetail = _classDescription(prediction.prediction, confPct);
  updateFanStateFromML(prediction.prediction, stateDetail, prediction.confidenceLevel);
}

/**
 * Atualiza o cartão principal de Estado do Ventilador com a previsão do ML
 */
function updateFanStateFromML(state, detail, confidenceLevel) {
  const fanStateEl = document.getElementById('fanState');
  const fanStateDetailEl = document.getElementById('fanStateDetail');
  const fanStateCard = document.getElementById('fanStateCard');

  if (!fanStateEl) return;

  fanStateEl.textContent = state;
  fanStateEl.className = 'card-value state-' + state.toLowerCase();

  if (fanStateDetailEl) {
    fanStateDetailEl.textContent = detail;
  }

  // Add visual indicator that this is ML prediction
  if (fanStateCard) {
    fanStateCard.classList.remove('ml-confidence-high', 'ml-confidence-medium', 'ml-confidence-low');
    if (confidenceLevel) {
      fanStateCard.classList.add('ml-confidence-' + confidenceLevel);
    }
  }
}

function getFeatureVectorFromPayload(normalized) {
  const featurePayloadKeys = [
    'gyro_z_dps_peak',
    'accel_x_g_skew',
    'gyro_y_dps_skew',
    'accel_x_g_kurtosis',
    'gyro_x_dps_shape_factor',
    'gyro_y_dps_shape_factor',
  ];
  const mode = (normalized.mode || '').toString().toLowerCase();
  const isFeaturePayload = Number.isFinite(normalized.feature_window)
    || mode === 'normal'
    || featurePayloadKeys.some(key => Number.isFinite(normalized[key]));

  if (!isFeaturePayload) {
    return null;
  }

  const modelFeatures = window.mlModelData?.features || window.fanClassifier?.getModelInfo?.()?.features;
  if (!Array.isArray(modelFeatures) || modelFeatures.length === 0) {
    return null;
  }
  const vector = {};
  let count = 0;
  for (const key of modelFeatures) {
    const value = normalized[key];
    if (Number.isFinite(value)) {
      vector[key] = value;
      count += 1;
    }
  }
  return count ? vector : null;
}

/**
 * Alimenta o classificador ML com um novo ponto de dados
 */
function feedMLData(normalized) {
  if (!ML_CONFIG.ENABLED || !window.fanClassifier || !window.fanClassifier.isReady) {
    return;
  }

  if (Number.isFinite(normalized.sample_rate)) {
    ensureModelForRate(normalized.sample_rate);
  }

  const featureVector = getFeatureVectorFromPayload(normalized);
  if (featureVector && window.fanClassifier.predictWithFeatures) {
    const windowSize = normalized.feature_window || window.ClassifierConfig?.WINDOW_SIZE || null;
    window.fanClassifier.predictWithFeatures(featureVector, windowSize);
    if (!mlDataOnline) {
      setMLDataOnline(true);
    }
    return;
  }

  if (window.fanClassifier.clearFeatureMode) {
    window.fanClassifier.clearFeatureMode();
  }
  if (Number.isFinite(normalized.counter)) {
    if (lastMLFeedCounter != null && normalized.counter < lastMLFeedCounter) {
      // Device restart or counter reset; reset ML buffer to avoid mixing sessions
      lastMLFeedCounter = null;
      lastMLFeedTs = null;
      if (window.fanClassifier) {
        window.fanClassifier.reset();
      }
    }
    if (lastMLFeedCounter != null && normalized.counter <= lastMLFeedCounter) {
      return;
    }
    lastMLFeedCounter = normalized.counter;
  } else {
    if (lastMLFeedTs != null && normalized.ts <= lastMLFeedTs) {
      return;
    }
  }
  lastMLFeedTs = normalized.ts;
  if (!mlDataOnline) {
    setMLDataOnline(true);
  }

  // Convert normalized data to classifier format
  const dataPoint = {
    ax: normalized.accel_x_g,
    ay: normalized.accel_y_g,
    az: normalized.accel_z_g,
    gx: normalized.gyro_x_dps,
    gy: normalized.gyro_y_dps,
    gz: normalized.gyro_z_dps,
    vib: normalized.vibration_dps != null ? normalized.vibration_dps : normalized.vibration,
    vibration: normalized.vibration_dps != null ? normalized.vibration_dps : normalized.vibration,
    timestamp: normalized.ts,
    counter: normalized.counter
  };

  window.fanClassifier.addData(dataPoint);
}

/**
 * Inicia o loop de predição do ML (roda periodicamente)
 */
function startMLPredictionLoop() {
  if (mlPredictionInterval) {
    clearInterval(mlPredictionInterval);
  }

  mlPredictionInterval = setInterval(() => {
    if (ML_CONFIG.ENABLED && window.fanClassifier && window.fanClassifier.isReady) {
      if (window.fanClassifier.isFeatureModeActive && window.fanClassifier.isFeatureModeActive()) {
        return;
      }
      window.fanClassifier.predict();
    }
  }, ML_CONFIG.PREDICTION_INTERVAL);
}

/**
 * Stop ML prediction loop
 */
function stopMLPredictionLoop() {
  if (mlPredictionInterval) {
    clearInterval(mlPredictionInterval);
    mlPredictionInterval = null;
  }
}

/**
 * Toggle ML classification on/off
 */
function toggleML() {
  ML_CONFIG.ENABLED = !ML_CONFIG.ENABLED;
  const btn = document.getElementById('mlToggle');

  if (ML_CONFIG.ENABLED) {
    btn.textContent = 'ML Ativo';
    btn.classList.add('btn-ml-active');
    if (mlDataOnline && window.fanClassifier && window.fanClassifier.isReady) {
      startMLPredictionLoop();
    }
  } else {
    btn.textContent = 'ML Inativo';
    btn.classList.remove('btn-ml-active');
    stopMLPredictionLoop();
  }
  syncMLBadgeState();
}

/**
 * Reseta o estado do classificador e recarrega o buffer com dados do cache
 */
function resetML() {
  if (window.fanClassifier) {
    lastMLFeedTs = null;
    lastMLFeedCounter = null;
    window.fanClassifier.reset();
    DriftMonitor.reset();
    updateMLUI({
      status: 'buffering',
      message: 'Recarregando buffer...',
      bufferProgress: 0
    });

    // Reload buffer from existing cache data
    const mlWindowSize = window.ClassifierConfig?.WINDOW_SIZE || 100;
    const recentData = cache.slice(-mlWindowSize);

    if (recentData.length > 0) {
      console.log(`[ML] Reloading buffer with ${recentData.length} points from cache`);
      recentData.forEach(item => {
        feedMLData(item);
      });

      // Trigger immediate prediction if we have enough data
      setTimeout(() => {
        if (window.fanClassifier && window.fanClassifier.isReady) {
          window.fanClassifier.predict();
        }
      }, 100);
    } else {
      console.log('[ML] No cache data available, waiting for new data');
    }
  }
}

// Sobrescreve fetchLatest para injetar dados no ML automaticamente
const originalFetchLatest = fetchLatest;
fetchLatest = async function () {
  if (latestFetchInFlight) {
    return;
  }
  latestFetchInFlight = true;
  const fetchSingleLatest = async () => {
    const response = await fetch(withDeviceId(CONFIG.API_ENDPOINT), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const responseData = await response.json();
    const payload = responseData.data;
    const serverConfig = responseData.config;
    applyServerConfig(serverConfig);
    const normalized = normalizePayload(payload);
    lastPayload = normalized;
    const hasCounter = Number.isFinite(normalized.counter);
    const isNewSample = hasCounter
      ? normalized.counter !== lastSeenCounter
      : normalized.ts !== lastDataTs;

    if (normalized.hasRealTimestamp) lastSampleTs = normalized.ts;
    lastFetchAt = getNow();

    if (isNewSample) {
      lastSeenCounter = hasCounter ? normalized.counter : lastSeenCounter;
    }
    lastDataTs = normalized.ts;

    pushCache(normalized);
    feedMLData(normalized);
    updateStatus(isFresh());
    updateCards(normalized);
    updateAlerts(normalized);
    renderAll();
  };

  try {
    if (CONFIG.HISTORY_ENDPOINT) {
      const url = withDeviceId(`${CONFIG.HISTORY_ENDPOINT}?mode=history&seconds=${CONFIG.REALTIME_WINDOW_SECONDS}`);
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      const responseData = await response.json();
      const payload = responseData.data;
      const serverConfig = responseData.config;

      // Adjust rate if needed
      applyServerConfig(serverConfig);

      if (!Array.isArray(payload) || payload.length === 0) {
        await fetchSingleLatest();
        return;
      }

      const batch = payload.slice().sort((a, b) => {
        const tsA = normalizeTimestampMs(a.timestamp_ms ?? a.timestamp ?? a.timestamp_s ?? a.ts, 0);
        const tsB = normalizeTimestampMs(b.timestamp_ms ?? b.timestamp ?? b.timestamp_s ?? b.ts, 0);
        return tsA - tsB;
      });

      let latestNormalized = null;
      let anyNew = false;

      batch.forEach(item => {
        const normalized = normalizePayload(item);
        const hasCounter = Number.isFinite(normalized.counter);
        if (hasCounter && lastSeenCounter != null && normalized.counter < lastSeenCounter) {
          // Device reset detected; allow new sequence
          lastSeenCounter = null;
          lastDataTs = null;
        }
        const isNewSample = hasCounter
          ? (lastSeenCounter == null || normalized.counter > lastSeenCounter)
          : (lastDataTs == null || normalized.ts > lastDataTs);

        if (!isNewSample) {
          return;
        }

        anyNew = true;
        lastSeenCounter = hasCounter ? normalized.counter : lastSeenCounter;
        lastDataTs = normalized.ts;
        if (normalized.hasRealTimestamp) lastSampleTs = normalized.ts;
        lastFetchAt = getNow();

        pushCache(normalized);
        feedMLData(normalized);
        latestNormalized = normalized;
      });

      if (!anyNew && batch.length) {
        // No new samples, but keep UI alive with most recent payload
        const normalized = normalizePayload(batch[batch.length - 1]);
        latestNormalized = normalized;
        if (normalized.hasRealTimestamp) lastSampleTs = normalized.ts;
        lastFetchAt = getNow();
      }

      updateStatus(isFresh());
      if (latestNormalized) {
        lastPayload = latestNormalized;
        updateCards(latestNormalized);
        updateAlerts(latestNormalized);
      }

      // CORREÇÃO: Força a atualização dos gráficos com os novos dados do lote.
      renderAll();
      return;
    }

    await fetchSingleLatest();
  } catch (err) {
    try {
      await fetchSingleLatest();
    } catch (fallbackErr) {
      updateStatus(false);
      console.error('Falha ao buscar dados:', err, fallbackErr);
    }
  } finally {
    latestFetchInFlight = false;
  }
};

// Sobrescreve fetchHistory para pré-carregar o buffer do ML
const originalFetchHistory = fetchHistory;
fetchHistory = async function () {
  if (!CONFIG.HISTORY_ENDPOINT) {
    return;
  }
  try {
    const url = withDeviceId(`${CONFIG.HISTORY_ENDPOINT}?mode=history&seconds=${CONFIG.HISTORY_SECONDS}`);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const responseData = await response.json();
    const payload = responseData.data;
    const serverConfig = responseData.config;

    // Adjust rate if needed
    applyServerConfig(serverConfig);

    if (!Array.isArray(payload)) {
      return;
    }

    // Sort by timestamp and feed to classifier
    const sorted = payload.sort((a, b) => {
      const tsA = normalizeTimestampMs(a.timestamp_ms ?? a.timestamp ?? a.timestamp_s ?? a.ts, 0);
      const tsB = normalizeTimestampMs(b.timestamp_ms ?? b.timestamp ?? b.timestamp_s ?? b.ts, 0);
      return tsA - tsB;
    });

    // Take last N points for ML buffer (to quickly initialize)
    const mlWindowSize = window.ClassifierConfig?.WINDOW_SIZE || 100;
    const recentForML = sorted.slice(-mlWindowSize);

    sorted.forEach(item => {
      pushCache(normalizePayload(item));
    });

    // Feed recent data to ML classifier
    recentForML.forEach(item => {
      feedMLData(normalizePayload(item));
    });

    // Update cards/status using the most recent payload
    if (sorted.length) {
      const latestNormalized = normalizePayload(sorted[sorted.length - 1]);
      lastPayload = latestNormalized;
      if (latestNormalized.hasRealTimestamp) lastSampleTs = latestNormalized.ts;
      lastFetchAt = getNow();
      lastDataTs = latestNormalized.ts;
      if (Number.isFinite(latestNormalized.counter)) {
        lastSeenCounter = latestNormalized.counter;
      }
      updateStatus(isFresh());
      updateCards(latestNormalized);
      updateAlerts(latestNormalized);
    }

    renderAll();
  } catch (err) {
    console.warn('Histórico não carregado:', err);
  }
};

// =============================================================================
// TRANSITION TRACKING UI + PERSISTENCE
// =============================================================================

function updateTransitionUI(entry) {
  // Atualiza "última transição" no card ML
  const lastTransEl = document.getElementById('mlLastTransition');
  if (lastTransEl) {
    lastTransEl.textContent = `${entry.from} → ${entry.to}  (${entry.duration_s}s)`;
    lastTransEl.className = 'ml-transition-value state-' + entry.to.toLowerCase();
  }

  // Atualiza log colapsável
  const logEl = document.getElementById('mlTransitionLog');
  if (logEl && window.fanClassifier) {
    const log = window.fanClassifier.getTransitionLog();
    logEl.innerHTML = log.slice().reverse().map(e => {
      const color = e.duration_s > 15 ? '#ff5252' : e.duration_s > 8 ? '#ffc107' : '#00ff88';
      return `<div class="ml-transition-entry">
        <span style="color:rgba(255,255,255,0.5)">${e.time}</span>
        <span class="state-${e.from.toLowerCase()}">${e.from}</span> →
        <span class="state-${e.to.toLowerCase()}">${e.to}</span>
        <span style="color:${color};font-weight:600">${e.duration_s}s</span>
        <span style="color:rgba(255,255,255,0.4)">${e.featureAgreement?.ratio || '--'}</span>
      </div>`;
    }).join('');
  }
}

function updateTransitionMeta(prediction) {
  // Concordância de features em tempo real
  const agreeEl = document.getElementById('mlFeatureAgreement');
  if (agreeEl && prediction.featureAgreement) {
    const fa = prediction.featureAgreement;
    agreeEl.textContent = fa.ratio;
    agreeEl.className = 'ml-transition-value';
    if (fa.best && fa.best === prediction.prediction) {
      agreeEl.classList.add('state-' + fa.best.toLowerCase());
    }
  }

  // Timer de transição pendente
  const timerEl = document.getElementById('mlTransitionTimer');
  if (timerEl) {
    if (prediction.transitionPending) {
      timerEl.textContent = (prediction.transitionElapsed / 1000).toFixed(1) + 's';
      timerEl.style.color = '#ffc107';
    } else {
      timerEl.textContent = 'Estável';
      timerEl.style.color = '#00ff88';
    }
  }
}

function persistTransitionLog(entry) {
  // Enrich transition logs with traceability context (model + sampling rate + classifier config)
  // so the runtime log can be linked back to the exact trained artifacts.
  const model = window.mlModelData || null;
  const payload = {
    ...(entry || {}),
    type: (entry && entry.type) ? entry.type : 'transition',
    trace: {
      configured_sample_rate_hz: (typeof lastServerConfig !== 'undefined' && lastServerConfig)
        ? (lastServerConfig.sample_rate ?? null)
        : null,
      collection_id: (typeof lastPayload !== 'undefined' && lastPayload)
        ? (lastPayload.collection_id || null)
        : null,
      training_sample_rate_hz: model?.eda_traceability?.sample_rate_hz ?? null,
    },
    model: {
      url: (typeof mlModelUrl !== 'undefined' && mlModelUrl) ? mlModelUrl : (window.ML_CONFIG?.MODEL_URL || null),
      model_version: model?.version ?? null,
      eda_id: model?.eda_traceability?.eda_id ?? null,
      fe_id: model?.eda_traceability?.fe_id ?? null,
      eda_version: model?.eda_traceability?.feature_config_version ?? null,
      collection_ids: model?.eda_traceability?.collection_ids ?? null,
      features_csv_hash: model?.eda_traceability?.features_csv_hash ?? null,
    },
    classifier_config: {
      window_size: window.ClassifierConfig?.WINDOW_SIZE ?? null,
      min_points: window.ClassifierConfig?.MIN_POINTS ?? null,
      prediction_interval_ms: window.ClassifierConfig?.PREDICTION_INTERVAL_MS ?? null,
      smoothing_alpha: window.ClassifierConfig?.SMOOTHING_ALPHA ?? null,
      hysteresis_count: window.ClassifierConfig?.HYSTERESIS_COUNT ?? null,
      confidence_gate: window.ClassifierConfig?.CONFIDENCE_GATE ?? null,
      confidence_margin: window.ClassifierConfig?.CONFIDENCE_MARGIN ?? null,
      adjacent_transition_confidence_gate: window.ClassifierConfig?.ADJACENT_TRANSITION_CONFIDENCE_GATE ?? null,
      adjacent_transition_confidence_margin: window.ClassifierConfig?.ADJACENT_TRANSITION_CONFIDENCE_MARGIN ?? null,
      adjacent_transition_hysteresis_count: window.ClassifierConfig?.ADJACENT_TRANSITION_HYSTERESIS_COUNT ?? null,
    },
  };

  fetch('../api/log_transition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(err => console.warn('[TransitionLog] Falha ao salvar:', err));
}

function splitDirectionKey(key) {
  if (key.includes('→')) return key.split('→');
  if (key.includes('->')) return key.split('->');
  if (key.includes('â†’')) return key.split('â†’');
  return [key, ''];
}

function summarizeByDirection(results) {
  const dirs = {};
  for (const r of results) {
    if (r.timeout) continue;
    const key = `${r.from}→${r.to}`;
    if (!dirs[key]) dirs[key] = [];
    dirs[key].push(r.time_s);
  }
  const summary = {};
  for (const [dir, times] of Object.entries(dirs)) {
    summary[dir] = {
      count: times.length,
      avg_s: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1),
      max_s: Math.max(...times),
      min_s: Math.min(...times),
    };
  }
  return summary;
}

function buildTransitionSummary(results, totalDurationS) {
  const transitions = results || [];
  const successful = transitions.filter(r => !r.timeout);
  const times = successful.map(r => r.time_s).filter(v => Number.isFinite(v));
  const avg = times.length ? +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : null;
  const min = times.length ? Math.min(...times) : null;
  const max = times.length ? Math.max(...times) : null;
  return {
    total_transitions: transitions.length,
    timeouts: transitions.filter(r => r.timeout).length,
    avg_time_s: avg,
    min_time_s: min,
    max_time_s: max,
    total_duration_s: totalDurationS ?? null,
    per_direction: summarizeByDirection(transitions),
  };
}

function buildTransitionSummaryHtml(summary) {
  const fmt = (v) => {
    const num = Number(v);
    return Number.isFinite(num) ? num.toFixed(1) : '--';
  };
  const avgTime = summary?.avg_time_s != null ? fmt(summary.avg_time_s) : '--';
  const minTime = summary?.min_time_s != null ? fmt(summary.min_time_s) : '--';
  const maxTime = summary?.max_time_s != null ? fmt(summary.max_time_s) : '--';
  const avgTimeText = avgTime === '--' ? '--' : `${avgTime}s`;
  const minTimeText = minTime === '--' ? '--' : `${minTime}s`;
  const maxTimeText = maxTime === '--' ? '--' : `${maxTime}s`;
  const totalDur = summary?.total_duration_s != null ? `${summary.total_duration_s}s` : '--';
  const timeoutCount = summary?.timeouts != null ? Number(summary.timeouts) : null;
  const timeouts = summary?.timeouts != null && summary?.total_transitions != null
    ? `${summary.timeouts}/${summary.total_transitions}`
    : '--';

  const dirs = summary?.per_direction || {};
  let dirRows = '';
  for (const [dir, d] of Object.entries(dirs)) {
    const c = d.avg_s > 15 ? '#ffc107' : '#00ff88';
    dirRows += `<tr>
      <td>${dir}</td>
      <td>${d.count}</td>
      <td style="color:${c};font-weight:600;">${fmt(d.avg_s)}s</td>
      <td>${fmt(d.min_s)}s</td>
      <td>${fmt(d.max_s)}s</td>
    </tr>`;
  }

  // Assimetria (subida vs descida)
  let asymmetryHtml = '';
  let asymmetryRatio = null;
  const upDirs = [];
  const downDirs = [];
  const order = {}; _getModelLabels().forEach((l, i) => { order[l] = i; });
  for (const [k, d] of Object.entries(dirs)) {
    const [f, t] = splitDirectionKey(k);
    if ((order[t] ?? 0) > (order[f] ?? 0)) upDirs.push([k, d]);
    if ((order[t] ?? 0) < (order[f] ?? 0)) downDirs.push([k, d]);
  }
  if (upDirs.length && downDirs.length) {
    const upAvg = upDirs.reduce((s, [, d]) => s + d.avg_s * d.count, 0) / upDirs.reduce((s, [, d]) => s + d.count, 0);
    const downAvg = downDirs.reduce((s, [, d]) => s + d.avg_s * d.count, 0) / downDirs.reduce((s, [, d]) => s + d.count, 0);
    const ratio = downAvg > 0 && upAvg > 0 ? (Math.max(upAvg, downAvg) / Math.min(upAvg, downAvg)) : null;
    if (ratio) {
      const slower = downAvg > upAvg ? 'Desacelerar' : 'Acelerar';
      asymmetryRatio = ratio;
      asymmetryHtml = `<div style="margin-top:8px;padding:6px 10px;background:rgba(255,255,255,0.04);border-radius:6px;font-size:0.75rem;">
        Assimetria: <strong style="color:#00d9ff;">${ratio.toFixed(2)}x</strong> (${slower} é mais lento)
        &nbsp;|&nbsp; Subir: ${upAvg.toFixed(1)}s &nbsp; Descer: ${downAvg.toFixed(1)}s
      </div>`;
    }
  }

  const html = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px;">
      <div style="text-align:center;padding:6px;background:rgba(255,255,255,0.04);border-radius:6px;">
        <div style="font-size:0.6rem;color:rgba(255,255,255,0.4);">Média</div>
        <div style="font-size:1.1rem;font-weight:700;color:#00ff88;">${avgTimeText}</div>
      </div>
      <div style="text-align:center;padding:6px;background:rgba(255,255,255,0.04);border-radius:6px;">
        <div style="font-size:0.6rem;color:rgba(255,255,255,0.4);">Mín / Máx</div>
        <div style="font-size:1.1rem;font-weight:700;color:#00d9ff;">${minTimeText} / ${maxTimeText}</div>
      </div>
      <div style="text-align:center;padding:6px;background:rgba(255,255,255,0.04);border-radius:6px;">
        <div style="font-size:0.6rem;color:rgba(255,255,255,0.4);">Timeouts</div>
        <div style="font-size:1.1rem;font-weight:700;color:${timeoutCount ? '#ff5252' : '#00ff88'};">${timeouts}</div>
      </div>
      <div style="text-align:center;padding:6px;background:rgba(255,255,255,0.04);border-radius:6px;">
        <div style="font-size:0.6rem;color:rgba(255,255,255,0.4);">Duração Total</div>
        <div style="font-size:1.1rem;font-weight:700;color:rgba(255,255,255,0.7);">${totalDur}</div>
      </div>
    </div>
    <table>
      <thead><tr><th>Direção</th><th>N</th><th>Média</th><th>Mín</th><th>Máx</th></tr></thead>
      <tbody>${dirRows}</tbody>
    </table>
    ${asymmetryHtml}
  `;

  return { html, asymmetryRatio };
}

// =============================================================================
// GUIDED TRANSITION TEST
// =============================================================================

const TransitionTest = {
  // Steps generated dynamically based on model labels (adjacent transitions only)
  STEPS: null,

  _generateSteps() {
    // Custom order field overrides the global model label order.
    // Supports 3-stage protocol: ROT_ON only, ROT_OFF only, or stress (cross-domain).
    const customRaw = (document.getElementById('ttCfgCustomOrder')?.value || '').trim();
    let labels;
    if (customRaw) {
      const valid = new Set(_getModelLabels());
      const parsed = customRaw.split(',').map(s => s.trim().toUpperCase()).filter(s => valid.has(s));
      labels = parsed.length >= 2 ? parsed : _getModelLabels();
    } else {
      labels = _getModelLabels();
    }
    const steps = [{ from: null, to: labels[0], label: `Coloque em ${_classShort(labels[0])} e aguarde` }];
    // Forward: go through all adjacent pairs in the chosen order
    for (let i = 0; i < labels.length - 1; i++) {
      steps.push({ from: labels[i], to: labels[i + 1],
        label: `Mude para ${_classShort(labels[i + 1])}` });
    }
    // Backward: return through all adjacent pairs in reverse
    for (let i = labels.length - 1; i > 0; i--) {
      steps.push({ from: labels[i], to: labels[i - 1],
        label: `Volte para ${_classShort(labels[i - 1])}` });
    }
    return steps;
  },

  PHASE_PREPARE: 'prepare',
  PHASE_CHANGE: 'change',
  PHASE_DETECTING: 'detecting',

  // Configurable defaults (read from UI inputs)
  _getCfg() {
    return {
      stabilizeS: parseFloat(document.getElementById('ttCfgStabilize')?.value) || 15,
      initialWaitS: parseFloat(document.getElementById('ttCfgInitialWait')?.value) || 30,
      timeoutS:   parseFloat(document.getElementById('ttCfgTimeout')?.value) || 90,
      confirmMs:  (parseFloat(document.getElementById('ttCfgConfirm')?.value) || 3) * 1000,
      prepareS:   parseFloat(document.getElementById('ttCfgPrepare')?.value) || 5,
      tag: (document.getElementById('ttCfgTag')?.value || '').trim() || null,
      notes: (document.getElementById('ttCfgNotes')?.value || '').trim() || null,
      customOrder: (document.getElementById('ttCfgCustomOrder')?.value || '').trim() || null,
    };
  },

  running: false,
  stepIndex: 0,
  phase: null,
  phaseStartTime: null,
  changeTime: null,
  stableStartTime: null,
  timerInterval: null,
  results: [],
  fullLog: [],
  testStartTime: null,
  testEndTime: null,
  stepStartedAt: null,
  completed: false,
  _audioCtx: null,
  _lastBeepSec: null,

  start() {
    this.STEPS = this._generateSteps();
    const cfg = this._getCfg();
    this.running = true;
    this.stepIndex = 0;
    this.phase = null;
    this.results = [];
    this.fullLog = [];
    this.stableStartTime = null;
    this.testStartTime = Date.now();
    this.testEndTime = null;
    this.stepStartedAt = this.testStartTime;
    this.completed = false;
    this._lastBeepSec = null;

    fetch('../api/log_transition?action=new')
      .then(r => r.json())
      .then(d => {
        console.log('[TransitionTest] Novo log:', d.file);
        loadTransitionLogList();
      })
      .catch(err => console.warn('[TransitionTest] Falha ao criar log:', err));

    document.getElementById('testStartBtn').disabled = true;
    document.getElementById('testStopBtn').disabled = false;
    document.getElementById('testBadge').textContent = 'Rodando';
    document.getElementById('testBadge').className = 'ml-badge ml-badge-active';
    document.getElementById('testResults').innerHTML = '';
    document.getElementById('ttSummarySection').style.display = 'none';

    this._updateGlobalProgress();
    this._buildStepBar();

    if (window.fanClassifier) window.fanClassifier.reset();

    this._startPhase(this.PHASE_PREPARE);
    this.timerInterval = setInterval(() => this._tick(), 200);
  },

  stop() {
    this.running = false;
    this.testEndTime = Date.now();
    clearInterval(this.timerInterval);
    this.timerInterval = null;

    document.getElementById('testStartBtn').disabled = false;
    document.getElementById('testStopBtn').disabled = true;
    document.getElementById('testBadge').textContent = 'Parado';
    document.getElementById('testBadge').className = 'ml-badge ml-badge-offline';
    this._setInstruction('Teste interrompido (log nao salvo)', 'rgba(255,255,255,0.4)', '');
    document.getElementById('testTimer').textContent = '--';
    this._updateGlobalProgress();
    console.log('[TransitionTest] Teste interrompido manualmente — log descartado.');
  },

  _beep(freq, durationMs) {
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = this._audioCtx.createOscillator();
      const gain = this._audioCtx.createGain();
      osc.connect(gain);
      gain.connect(this._audioCtx.destination);
      osc.frequency.value = freq;
      gain.gain.value = 0.15;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, this._audioCtx.currentTime + durationMs / 1000);
      osc.stop(this._audioCtx.currentTime + durationMs / 1000);
    } catch (e) { /* audio not supported */ }
  },

  _updateGlobalProgress() {
    const total = this.STEPS.length;
    const done = Math.min(this.stepIndex, total);
    const pct = (done / total * 100).toFixed(0);
    const fill = document.getElementById('ttProgressFill');
    const text = document.getElementById('ttProgressText');
    const elapsed = document.getElementById('ttElapsedTime');
    const rangeEl = document.getElementById('ttTimeRange');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = `Etapa ${done}/${total}`;
    if (elapsed && this.testStartTime) {
      const secs = Math.floor((Date.now() - this.testStartTime) / 1000);
      const m = String(Math.floor(secs / 60)).padStart(2, '0');
      const s = String(secs % 60).padStart(2, '0');
      elapsed.textContent = `${m}:${s}`;
    }
    if (rangeEl && this.testStartTime) {
      const fmt = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const cfg = this._getCfg();
      const maxTotalS =
        Math.max(0, cfg.stabilizeS || 0) +
        Math.max(0, cfg.initialWaitS || 0) +
        Math.max(0, (this.STEPS.length - 1)) * (Math.max(0, cfg.prepareS || 0) + Math.max(0, cfg.timeoutS || 0));
      const predictedEnd = this.testStartTime + (maxTotalS * 1000);
      const startStr = fmt(this.testStartTime);
      const endStr = this.testEndTime ? fmt(this.testEndTime) : '--';
      const predStr = Number.isFinite(predictedEnd) ? fmt(predictedEnd) : '--';
      rangeEl.textContent = `Inicio: ${startStr} | Fim: ${endStr} | Prev max: ${predStr}`;
    } else if (rangeEl) {
      rangeEl.textContent = '';
    }
  },

  _buildStepBar() {
    const bar = document.getElementById('testStepBar');
    if (!bar) return;
    bar.innerHTML = this.STEPS.map((s, i) => {
      const c = _classColor(s.to);
      return `<div id="testStep${i}" style="flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,0.1);position:relative;">
        <div style="position:absolute;inset:0;border-radius:3px;background:${c};opacity:0;transition:opacity 0.3s;" id="testStepFill${i}"></div>
        <div style="position:absolute;top:10px;left:0;right:0;text-align:center;font-size:0.55rem;color:rgba(255,255,255,0.4);">${_classShort(s.to)}</div>
      </div>`;
    }).join('');
  },

  _markStep(index, status) {
    const fill = document.getElementById(`testStepFill${index}`);
    if (!fill) return;
    if (status === 'active') { fill.style.opacity = '0.5'; fill.style.animation = 'mlGradient 1s ease infinite'; }
    else if (status === 'done') { fill.style.opacity = '1'; fill.style.animation = 'none'; }
    else { fill.style.opacity = '0'; fill.style.animation = 'none'; }
  },

  _startPhase(phase) {
    this.phase = phase;
    this.phaseStartTime = Date.now();
    this.stableStartTime = null;
    this._lastBeepSec = null;
    if (phase === this.PHASE_PREPARE) {
      this.stepStartedAt = this.phaseStartTime;
    }

    const step = this.STEPS[this.stepIndex];
    if (!step) return;

    this._markStep(this.stepIndex, 'active');
    this._updateGlobalProgress();

    if (phase === this.PHASE_PREPARE) {
      this._setInstruction(
        step.label,
        'rgba(255,255,255,0.6)',
        `Etapa ${this.stepIndex + 1}/${this.STEPS.length} — Contagem regressiva`
      );
    } else if (phase === this.PHASE_CHANGE) {
      this.changeTime = Date.now();
      this._beep(880, 300);
      this._setInstruction(
        `MUDE PARA ${step.to} AGORA!`,
        colors[step.to],
        `Cronometrando detecção...`
      );
      this._logTick('CHANGE_COMMAND');
    }
  },

  _setInstruction(text, color, info) {
    const el = document.getElementById('testInstruction');
    if (el) { el.innerHTML = text; el.style.color = color; }
    const infoEl = document.getElementById('testPhaseInfo');
    if (infoEl) infoEl.textContent = info;
  },

  _tick() {
    if (!this.running) return;
    const step = this.STEPS[this.stepIndex];
    if (!step) return;

    const cfg = this._getCfg();
    const now = Date.now();
    const elapsed = (now - this.phaseStartTime) / 1000;

    // Update global elapsed time
    this._updateGlobalProgress();

    const pred = window.fanClassifier?.lastPrediction;
    const currentClass = pred?.confirmedState || pred?.prediction || '--';
    const classEl = document.getElementById('testCurrentClass');
    if (classEl) {
      classEl.textContent = currentClass;
      classEl.className = '';
      if (currentClass !== '--') classEl.classList.add('state-' + currentClass.toLowerCase());
    }

    this._logTick(this.phase);

    // === FASE PREPARAÇÃO ===
    if (this.phase === this.PHASE_PREPARE) {
      const prepTime = this.stepIndex === 0 ? cfg.stabilizeS : cfg.prepareS;
      const remaining = Math.max(0, prepTime - elapsed);
      const timerEl = document.getElementById('testTimer');

      if (this.stepIndex === 0) {
        const elapsedTotalS = (now - this.testStartTime) / 1000;
        timerEl.textContent = elapsedTotalS.toFixed(1) + 's';
        timerEl.style.color = 'rgba(255,255,255,0.6)';

        if (remaining <= 0) {
          const stabilizedAt = this.phaseStartTime + (Math.max(0, cfg.stabilizeS || 0) * 1000);
          const waitElapsedS = Math.max(0, (now - stabilizedAt) / 1000);
          const maxWaitS = Math.max(0, cfg.initialWaitS || 0);

          if (currentClass === step.to) {
            this._markStep(this.stepIndex, 'done');
            this._recordResult(step, +waitElapsedS.toFixed(1), pred, {
              isInitial: true,
              step_started_at: this.stepStartedAt,
              step_finished_at: now,
              initial_wait_s: maxWaitS,
              initial_wait_elapsed_s: +waitElapsedS.toFixed(1),
              forced: false,
              observed_class: currentClass,
            });
            this.stepIndex++;
            if (this.stepIndex < this.STEPS.length) this._startPhase(this.PHASE_PREPARE);
            else this._finish();
          } else if (maxWaitS <= 0 || waitElapsedS >= maxWaitS) {
            // Force start after initial wait window to keep the test finite.
            this._beep(220, 250);
            this._markStep(this.stepIndex, 'done');
            this._recordResult(step, +waitElapsedS.toFixed(1), pred, {
              isInitial: true,
              step_started_at: this.stepStartedAt,
              step_finished_at: now,
              initial_wait_s: maxWaitS,
              initial_wait_elapsed_s: +waitElapsedS.toFixed(1),
              forced: true,
              forced_reason: 'initial_wait_timeout',
              observed_class: currentClass,
            });
            this._setInstruction(
              `Início FORÇADO (${_classShort(step.to)} não confirmado)`,
              '#ffc107',
              `Continuando após ${waitElapsedS.toFixed(1)}s de espera`
            );
            this.stepIndex++;
            if (this.stepIndex < this.STEPS.length) this._startPhase(this.PHASE_PREPARE);
            else this._finish();
          } else {
            this._setInstruction(
              `Aguardando classificação: ${_classShort(step.to)}`,
              '#ffc107',
              `Coloque o ventilador em ${_classShort(step.to)} para iniciar | espera: ${waitElapsedS.toFixed(1)}s/${maxWaitS}s`
            );
          }
          return;
        }
      } else {
        if (remaining > 3) {
          timerEl.textContent = Math.ceil(remaining) + 's';
          timerEl.style.color = 'rgba(255,255,255,0.6)';
        } else if (remaining > 0) {
          const sec = Math.ceil(remaining);
          timerEl.textContent = sec;
          timerEl.style.color = '#ffc107';
          timerEl.style.fontSize = '4rem';
          // Beep nos últimos 3 segundos
          if (this._lastBeepSec !== sec) {
            this._lastBeepSec = sec;
            this._beep(sec === 1 ? 660 : 440, 150);
          }
        }

        if (remaining <= 0) {
          const timerEl2 = document.getElementById('testTimer');
          if (timerEl2) timerEl2.style.fontSize = '3rem';
          this._startPhase(this.PHASE_CHANGE);
          return;
        }
      }
      return;
    }

    // === FASE MUDE AGORA / DETECTANDO ===
    if (this.phase === this.PHASE_CHANGE || this.phase === this.PHASE_DETECTING) {
      const sinceChange = (now - this.changeTime) / 1000;
      const timerEl = document.getElementById('testTimer');
      timerEl.textContent = sinceChange.toFixed(1) + 's';
      timerEl.style.fontSize = '3rem';

      if (sinceChange < 8) timerEl.style.color = '#00ff88';
      else if (sinceChange < 20) timerEl.style.color = '#ffc107';
      else timerEl.style.color = '#ff5252';

      if (this.phase === this.PHASE_CHANGE && sinceChange >= 1) {
        this.phase = this.PHASE_DETECTING;
        this._setInstruction(
          `Aguardando: ${_classShort(step.to)}`,
          _classColor(step.to),
          `Detectando mudança... (atual: ${_classShort(currentClass)})`
        );
      }

      if (this.phase === this.PHASE_DETECTING) {
        document.getElementById('testPhaseInfo').textContent =
          `Detectando mudança... (atual: ${_classShort(currentClass)})`;

        if (currentClass === step.to) {
          if (!this.stableStartTime) {
            this.stableStartTime = now;
          } else if (now - this.stableStartTime >= cfg.confirmMs) {
            const detectionTime = +((this.stableStartTime - this.changeTime) / 1000).toFixed(1);
            this._markStep(this.stepIndex, 'done');
            this._recordResult(step, detectionTime, pred, {
              step_started_at: this.stepStartedAt,
              command_at: this.changeTime,
              detected_first_seen_at: this.stableStartTime,
              detected_confirmed_at: now,
              step_finished_at: now,
            });
            this._beep(1200, 200);

            timerEl.textContent = detectionTime + 's';
            timerEl.style.color = '#00ff88';

            setTimeout(() => {
              if (!this.running) return;
              this.stepIndex++;
              if (this.stepIndex < this.STEPS.length) this._startPhase(this.PHASE_PREPARE);
              else this._finish();
            }, 1000);
            this.phase = null;
            return;
          }
        } else {
          this.stableStartTime = null;
        }

        if (sinceChange > cfg.timeoutS) {
          this._beep(200, 500);
          this._markStep(this.stepIndex, 'done');
          this._recordResult(step, 'TIMEOUT', pred, {
            step_started_at: this.stepStartedAt,
            command_at: this.changeTime,
            detected_confirmed_at: now,
            step_finished_at: now,
          });
          this.stepIndex++;
          if (this.stepIndex < this.STEPS.length) this._startPhase(this.PHASE_PREPARE);
          else this._finish();
        }
      }
    }
  },

  _logTick(phase) {
    const pred = window.fanClassifier?.lastPrediction;
    if (!pred) return;
    const estRate = window.fanClassifier?._estimateSampleRate?.() ?? null;
    this.fullLog.push({
      t: Date.now(),
      ts_iso: new Date().toISOString(),
      step: this.stepIndex,
      phase,
      confirmed: pred.confirmedState,
      raw: pred.rawPrediction,
      confidence: +(pred.confidence * 100).toFixed(1),
      probabilities: pred.smoothedProbabilities
        ? Object.fromEntries(_getModelLabels().map(l =>
            [_classShort(l), +((pred.smoothedProbabilities[l]||0)*100).toFixed(1)]))
        : null,
      agreement: pred.featureAgreement?.ratio || null,
      buffer: pred.bufferSize,
      sample_rate_hz: estRate ? +estRate.toFixed(2) : null,
    });
    if (this.fullLog.length > 5000) this.fullLog.splice(0, 1000);
  },

  _recordResult(step, time, prediction, meta = {}) {
    // Back-compat: older calls used boolean isInitial.
    const m = (typeof meta === 'boolean') ? { isInitial: meta } : (meta || {});
    const isInitial = !!m.isInitial;
    const toIso = (ms) => Number.isFinite(ms) ? new Date(ms).toISOString() : null;

    const entry = {
      step: this.stepIndex + 1,
      from: step.from || '--',
      to: step.to,
      time_s: time === 'TIMEOUT' ? time : parseFloat(time),
      timeout: time === 'TIMEOUT',
      isInitial,
      forced: !!m.forced,
      forced_reason: m.forced_reason || null,
      step_started_at: toIso(m.step_started_at),
      command_at: toIso(m.command_at),
      detected_first_seen_at: toIso(m.detected_first_seen_at),
      detected_confirmed_at: toIso(m.detected_confirmed_at),
      step_finished_at: toIso(m.step_finished_at),
      initial_wait_s: Number.isFinite(m.initial_wait_s) ? m.initial_wait_s : null,
      initial_wait_elapsed_s: Number.isFinite(m.initial_wait_elapsed_s) ? m.initial_wait_elapsed_s : null,
      observed_class: m.observed_class || null,
      confidence: prediction ? +(prediction.confidence * 100).toFixed(1) : 0,
      featureAgreement: prediction?.featureAgreement || {},
      timestamp: new Date().toISOString(),
    };
    this.results.push(entry);

    const resultsEl = document.getElementById('testResults');
    const fmtTime = (iso) => iso
      ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '--';
    const rangeStartIso = entry.command_at || entry.step_started_at || entry.timestamp;
    const rangeEndIso = entry.step_finished_at || entry.timestamp;
    const rangeStr = `${fmtTime(rangeStartIso)}→${fmtTime(rangeEndIso)}`;

    const baseColor = entry.timeout ? '#ff5252' : (entry.forced ? '#ffc107' : (entry.time_s > 15 ? '#ffc107' : '#00ff88'));
    let timeStr = entry.timeout ? 'TIMEOUT' : `${entry.time_s}s`;
    if (entry.forced) {
      const w = entry.initial_wait_elapsed_s != null ? `(${entry.initial_wait_elapsed_s}s)` : '';
      timeStr = `FORÇADO${w}`;
    }
    resultsEl.innerHTML += `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
      <span style="color:rgba(255,255,255,0.25);min-width:110px;font-size:0.65rem;font-family:'JetBrains Mono',monospace;">${rangeStr}</span>
      <span style="color:rgba(255,255,255,0.3);min-width:20px;">#${entry.step}</span>
      <span class="state-${entry.from.toLowerCase()}" style="min-width:55px;">${entry.from}</span>
      <span style="color:rgba(255,255,255,0.3);">→</span>
      <span class="state-${entry.to.toLowerCase()}" style="min-width:55px;">${entry.to}</span>
      <span style="color:${baseColor};font-weight:700;min-width:90px;text-align:right;">${timeStr}</span>
      <span style="color:rgba(255,255,255,0.3);font-size:0.7rem;">${entry.featureAgreement?.ratio || ''}</span>
    </div>`;
  },

  _finish() {
    this.running = false;
    this.testEndTime = Date.now();
    clearInterval(this.timerInterval);
    this.timerInterval = null;

    document.getElementById('testStartBtn').disabled = false;
    document.getElementById('testStopBtn').disabled = true;
    document.getElementById('testBadge').textContent = 'Concluído';
    document.getElementById('testBadge').className = 'ml-badge ml-badge-active';
    this._setInstruction('Teste concluído!', '#00ff88', 'Resultados salvos no log');
    document.getElementById('testTimer').textContent = '--';

    this.STEPS.forEach((_, i) => this._markStep(i, 'done'));
    this._updateGlobalProgress();

    this._beep(1400, 100);
    setTimeout(() => this._beep(1400, 100), 150);
    setTimeout(() => this._beep(1800, 200), 300);

    this.completed = true;
    this._showSummary();
    this._persistAll();
  },

  _showSummary() {
    const section = document.getElementById('ttSummarySection');
    const content = document.getElementById('ttSummaryContent');
    if (!section || !content) return;

    const trans = this.results.filter(r => !r.isInitial);
    const endMs = this.testEndTime || Date.now();
    const totalDur = this.testStartTime ? +((endMs - this.testStartTime) / 1000).toFixed(0) : null;
    const summary = buildTransitionSummary(trans, totalDur);
    const rendered = buildTransitionSummaryHtml(summary);
    content.innerHTML = rendered.html;

    section.style.display = 'block';

    // Baseline comparison
    this._showBaselineComparison(summary.per_direction, rendered.asymmetryRatio);
  },

  _showBaselineComparison(currentDirs, currentAsymmetry) {
    const model = window.mlModelData;
    if (!model) return;

    const baselineSection = document.getElementById('ttBaselineComparison');
    const baselineContent = document.getElementById('ttBaselineContent');
    if (!baselineSection || !baselineContent) return;

    // Check if model has asymmetry data
    const modelAsymmetry = model.metrics?.asymmetry_ratio;
    const modelConvergence = model.metrics?.avg_convergence_s;
    const modelVersion = model.version || 'unknown';

    // Even without baseline metrics, show model info
    let html = `<div style="font-size:0.7rem;color:rgba(255,255,255,0.5);margin-bottom:8px;">
      Modelo: <strong>${modelVersion}</strong> | Features: ${model.features?.length || '?'} | Samples: ${model.training_info?.total_samples || '?'}
    </div>`;

    if (modelAsymmetry && currentAsymmetry) {
      const diff = ((currentAsymmetry - modelAsymmetry) / modelAsymmetry * 100).toFixed(0);
      const diffColor = Math.abs(diff) < 20 ? '#00ff88' : '#ffc107';
      html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div style="padding:6px;background:rgba(255,255,255,0.04);border-radius:6px;text-align:center;">
          <div style="font-size:0.6rem;color:rgba(255,255,255,0.4);">Assimetria Baseline</div>
          <div style="font-size:1rem;font-weight:700;color:#00d9ff;">${modelAsymmetry.toFixed(2)}x</div>
        </div>
        <div style="padding:6px;background:rgba(255,255,255,0.04);border-radius:6px;text-align:center;">
          <div style="font-size:0.6rem;color:rgba(255,255,255,0.4);">Teste Atual</div>
          <div style="font-size:1rem;font-weight:700;color:${diffColor};">${currentAsymmetry.toFixed(2)}x <span style="font-size:0.7rem;">(${diff > 0 ? '+' : ''}${diff}%)</span></div>
        </div>
      </div>`;
    }

    if (modelConvergence) {
      html += `<div style="margin-top:6px;font-size:0.7rem;color:rgba(255,255,255,0.5);">
        Convergência média do modelo: <strong style="color:#00d9ff;">${modelConvergence}s</strong>
      </div>`;
    }

    if (!modelAsymmetry && !modelConvergence) {
      html += `<div style="font-size:0.7rem;color:rgba(255,255,255,0.35);font-style:italic;">
        Modelo atual não possui métricas de assimetria/convergência para comparação.
      </div>`;
    }

    baselineContent.innerHTML = html;
    baselineSection.style.display = 'block';
  },

  _persistAll() {
    if (!this.completed) {
      console.log('[TransitionTest] Teste incompleto — log nao sera salvo.');
      return;
    }
    if (!this.results.length && !this.fullLog.length) return;

    const rates = this.fullLog.filter(t => t.sample_rate_hz != null).map(t => t.sample_rate_hz);
    const avgRate = rates.length ? +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(2) : null;

    const cfg = this._getCfg();
    const transitionResults = this.results.filter(r => !r.isInitial);
    const endMs = this.testEndTime || Date.now();
    const testDurationS = this.testStartTime ? +((endMs - this.testStartTime) / 1000).toFixed(1) : null;
    const summary = buildTransitionSummary(transitionResults, testDurationS);
    const payload = {
      type: 'transition_test',
      test_time: new Date().toISOString(),
      test_started: this.testStartTime ? new Date(this.testStartTime).toISOString() : null,
      test_ended: this.testEndTime ? new Date(this.testEndTime).toISOString() : null,
      test_duration_s: testDurationS,
      test_tag: cfg.tag,
      test_notes: cfg.notes,
      trace: {
        tag: cfg.tag,
        notes: cfg.notes,
        configured_sample_rate_hz: lastServerConfig?.sample_rate ?? null,
        collection_id: lastPayload?.collection_id || null,
        training_sample_rate_hz: window.mlModelData?.eda_traceability?.sample_rate_hz || null,
      },
      model: {
        url: window.ML_CONFIG?.MODEL_URL || null,
        features_count: window.fanClassifier?.classifier?.featureNames?.length || null,
        model_version: window.mlModelData?.version || null,
        eda_version: window.mlModelData?.eda_traceability?.feature_config_version || null,
        eda_id: window.mlModelData?.eda_traceability?.eda_id || null,
        collection_ids: window.mlModelData?.eda_traceability?.collection_ids || null,
      },
      sample_rate: {
        estimated_avg_hz: avgRate,
        min_hz: rates.length ? +Math.min(...rates).toFixed(2) : null,
        max_hz: rates.length ? +Math.max(...rates).toFixed(2) : null,
      },
      test_config: {
        stabilize_s: cfg.stabilizeS,
        initial_wait_s: cfg.initialWaitS,
        timeout_s: cfg.timeoutS,
        confirm_ms: cfg.confirmMs,
        prepare_s: cfg.prepareS,
      },
      config: {
        window_size: window.ClassifierConfig?.WINDOW_SIZE,
        min_points: window.ClassifierConfig?.MIN_POINTS,
        smoothing_alpha: window.ClassifierConfig?.SMOOTHING_ALPHA,
        hysteresis_count: window.ClassifierConfig?.HYSTERESIS_COUNT,
        change_detect_ratio: window.ClassifierConfig?.CHANGE_DETECT_RATIO,
        change_detect_window: window.ClassifierConfig?.CHANGE_DETECT_WINDOW,
        fast_flush_keep: window.ClassifierConfig?.FAST_FLUSH_KEEP,
        var_floor: '1e-3',
        peak_method: 'P95',
      },
      results: transitionResults,
      results_all: this.results,
      summary: summary,
      tick_log: this.fullLog,
    };

    fetch('../api/log_transition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json())
      .then((resp) => {
        console.log('[TransitionTest] Resultados completos salvos:', payload.summary);
        if (resp?.file) {
          loadTransitionLogFile(resp.file);
        } else {
          loadTransitionLogList();
        }
      }).catch(err => console.warn('[TransitionTest] Falha ao salvar:', err));
  },

  _summarizeByDirection(results) {
    return summarizeByDirection(results);
  },
};

// =============================================================================
// TRANSITION TEST — 3-STAGE PRESETS
// =============================================================================
// Fills the ttCfgCustomOrder field with the appropriate label sequence.
// Stage 0 = default (clears field, uses global model order)
// Stage 1 = ROT_ON only  (LOW→MEDIUM→HIGH, reverse, FAN_OFF)
// Stage 2 = ROT_OFF only (same pattern with ROT_OFF suffix)
// Stage 3 = Stress — every adjacent pair is a cross-domain transition
function _ttPreset(stage) {
  const el = document.getElementById('ttCfgCustomOrder');
  if (!el) return;
  const PRESETS = {
    0: '',  // default — let _generateSteps use _getModelLabels()
    1: 'LOW_ROT_ON,MEDIUM_ROT_ON,HIGH_ROT_ON,FAN_OFF',
    2: 'LOW_ROT_OFF,MEDIUM_ROT_OFF,HIGH_ROT_OFF,FAN_OFF',
    3: 'FAN_OFF,HIGH_ROT_ON,LOW_ROT_OFF,MEDIUM_ROT_ON,HIGH_ROT_OFF,LOW_ROT_ON,MEDIUM_ROT_OFF',
  };
  const seq = PRESETS[stage] ?? '';
  el.value = seq;
  // Reflect back to user via placeholder colour hint
  el.style.borderColor = seq ? '#a78bfa' : '';
  const labels = {
    0: 'Padrão (todos)',
    1: 'Etapa 1 · ROT ON (LO→MD→HI→reverse→OFF)',
    2: 'Etapa 2 · ROT OFF (LO→MD→HI→reverse→OFF)',
    3: 'Etapa 3 · Stress (cross-domain aleatório)',
  };
  console.log(`[TransitionTest] Preset carregado: ${labels[stage] ?? stage}`);
}

// =============================================================================
// STABILITY / SOAK TEST (HOLD EACH STATE FOR N SECONDS)
// =============================================================================

function parseStabilitySequence(text) {
  const modelLabels = _getModelLabels();
  const valid = new Set(modelLabels);
  const raw = String(text || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
  const seq = raw.filter(x => valid.has(x));
  return seq.length ? seq : modelLabels;
}

function meanOf(arr) {
  const xs = (arr || []).filter(v => Number.isFinite(v));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sampleStdOf(arr) {
  const xs = (arr || []).filter(v => Number.isFinite(v));
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  let sumSq = 0;
  for (const v of xs) sumSq += (v - m) ** 2;
  return Math.sqrt(sumSq / (xs.length - 1));
}

function quantileOf(arr, q) {
  const xs = (arr || []).filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const pos = (xs.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = xs[base];
  const b = xs[Math.min(xs.length - 1, base + 1)];
  return a + rest * (b - a);
}

function summarizeNumeric(arr) {
  const xs = (arr || []).filter(v => Number.isFinite(v));
  if (!xs.length) return null;
  return {
    n: xs.length,
    mean: meanOf(xs),
    std: sampleStdOf(xs),
    min: Math.min(...xs),
    p10: quantileOf(xs, 0.10),
    p50: quantileOf(xs, 0.50),
    p90: quantileOf(xs, 0.90),
    max: Math.max(...xs),
  };
}

function entropyOfProbs(probObj) {
  if (!probObj || typeof probObj !== 'object') return null;
  const ps = Object.values(probObj).filter(v => Number.isFinite(v) && v > 0);
  if (!ps.length) return null;
  let h = 0;
  for (const p of ps) h -= p * Math.log2(p);
  return h;
}

function mergeStats(a, b) {
  // Stats as { n, mean, std } (sample std). Merge via Welford parallel combine.
  if (!a) return b;
  if (!b) return a;
  const n1 = a.n ?? 0;
  const n2 = b.n ?? 0;
  if (!Number.isFinite(n1) || !Number.isFinite(n2) || n1 <= 0) return b;
  if (n2 <= 0) return a;

  const mean1 = a.mean ?? 0;
  const mean2 = b.mean ?? 0;
  const var1 = (a.std != null && n1 > 1) ? (a.std ** 2) : 0;
  const var2 = (b.std != null && n2 > 1) ? (b.std ** 2) : 0;
  const m2_1 = var1 * Math.max(0, n1 - 1);
  const m2_2 = var2 * Math.max(0, n2 - 1);

  const n = n1 + n2;
  const delta = mean2 - mean1;
  const mean = mean1 + delta * (n2 / n);
  const m2 = m2_1 + m2_2 + (delta ** 2) * (n1 * n2 / n);
  const std = n > 1 ? Math.sqrt(m2 / (n - 1)) : null;
  return { n, mean, std };
}

function cohensDFromStats(a, b) {
  if (!a || !b) return null;
  const n1 = a.n ?? 0;
  const n2 = b.n ?? 0;
  if (n1 < 2 || n2 < 2) return null;
  const s1 = a.std ?? 0;
  const s2 = b.std ?? 0;
  const pooledVar = (((n1 - 1) * (s1 ** 2)) + ((n2 - 1) * (s2 ** 2))) / (n1 + n2 - 2);
  if (!(pooledVar > 0)) return null;
  return (a.mean - b.mean) / Math.sqrt(pooledVar);
}

function buildStabilitySummaryHtml(test) {
  if (!test) {
    return `<div style="font-size:0.75rem;color:rgba(255,255,255,0.45);font-style:italic;">
      Nenhum teste de estabilidade encontrado neste log.
    </div>`;
  }

  const segs = Array.isArray(test.segments) ? test.segments : [];
  const cfg = test.test_config || {};
  const holdS = cfg.hold_s != null ? cfg.hold_s : (cfg.holdS != null ? cfg.holdS : null);
  const settleS = cfg.settle_s != null ? cfg.settle_s : (cfg.settleS != null ? cfg.settleS : null);
  const seq = Array.isArray(cfg.sequence) ? cfg.sequence : null;
  const durationS = test.test_duration_s ?? test.testDurationS ?? null;

  const hdrParts = [];
  if (seq && seq.length) hdrParts.push(`Seq: ${seq.join('->')}`);
  if (holdS != null) hdrParts.push(`Hold: ${holdS}s`);
  if (settleS != null) hdrParts.push(`Settle: ${settleS}s`);
  if (durationS != null) hdrParts.push(`Total: ${durationS}s`);
  const hdr = hdrParts.length
    ? `<div style="font-size:0.7rem;color:rgba(255,255,255,0.55);margin-bottom:8px;">${hdrParts.join(' | ')}</div>`
    : '';

  const fmtPct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '--');
  const fmtNum = (v) => (Number.isFinite(v) ? v.toFixed(2) : '--');

  const rows = segs.map((s, i) => {
    const acc = s.target_ratio;
    const dom = s.dominant_ratio;
    const flips = s.flips_per_min;
    const conf = s.confidence?.mean;
    const gap = s.confidence_gap?.mean;
    const ent = s.entropy?.mean;
    const ttt = s.time_to_target_s;
    const tttStr = Number.isFinite(ttt)
      ? (ttt.toFixed(1) + 's')
      : (s.wait_timeout_triggered ? `TIMEOUT(${s.wait_timeout_s ?? '--'}s)` : '--');
    return `<tr>
      <td>#${i + 1}</td>
      <td style="color:${_classColor(s.target || '')}">${_classShort(s.target || '--')}</td>
      <td>${s.tick_n ?? '--'}</td>
      <td style="color:${(acc != null && acc < 0.85) ? '#ffc107' : '#00ff88'};font-weight:700;">${fmtPct(acc)}</td>
      <td>${fmtPct(dom)}</td>
      <td style="color:${(flips != null && flips > 6) ? '#ff5252' : (flips != null && flips > 2) ? '#ffc107' : '#00ff88'};font-weight:600;">${fmtNum(flips)}</td>
      <td>${fmtPct(conf)}</td>
      <td>${fmtPct(gap)}</td>
      <td>${fmtNum(ent)}</td>
      <td>${tttStr}</td>
    </tr>`;
  }).join('');

  const table = segs.length ? `
    <table>
      <thead>
        <tr>
          <th>Etapa</th><th>Alvo</th><th>N</th><th>Acerto</th><th>Dominante</th><th>Flips/min</th><th>Conf(M)</th><th>Gap(M)</th><th>Ent(M)</th><th>T->Alvo</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  ` : `<div style="font-size:0.75rem;color:rgba(255,255,255,0.45);font-style:italic;">Sem segmentos.</div>`;

  // Feature separation between adjacent pairs (if present)
  let fx = '';
  const featureEffects = test.summary?.feature_effects;
  if (featureEffects) {
    const firstKey = Object.keys(featureEffects)[0];
    const effects = firstKey ? featureEffects[firstKey] : null;
    if (effects && Array.isArray(effects.top) && effects.top.length) {
      const fxRows = effects.top.map(e => {
        const d = e.d;
        const c = Math.abs(d) >= 0.8 ? '#00ff88' : Math.abs(d) >= 0.5 ? '#00d9ff' : '#ffc107';
        return `<tr>
          <td>${e.feature}</td>
          <td style="color:${c};font-weight:700;">${Number.isFinite(d) ? d.toFixed(2) : '--'}</td>
          <td>${Number.isFinite(e.mean_a) ? e.mean_a.toFixed(4) : '--'}</td>
          <td>${Number.isFinite(e.mean_b) ? e.mean_b.toFixed(4) : '--'}</td>
        </tr>`;
      }).join('');
      const small = effects.small_abs_d_count != null
        ? `<div style="margin-top:6px;font-size:0.7rem;color:rgba(255,255,255,0.55);">|d|<0.20 (sobreposicao): ${effects.small_abs_d_count}/${effects.feature_count}</div>`
        : '';
      fx = `
        <div style="margin-top:10px;">
          <div style="font-size:0.75rem;color:#00d9ff;font-weight:600;margin-bottom:6px;">Separacao de Features (${firstKey})</div>
          <table>
            <thead><tr><th>Feature</th><th>Cohen's d</th><th>Mean A</th><th>Mean B</th></tr></thead>
            <tbody>${fxRows}</tbody>
          </table>
          ${small}
        </div>
      `;
    }
  }

  return `${hdr}${table}${fx}`;
}

const StabilityTest = {
  PHASE_PREPARE: 'prepare',
  PHASE_WAIT_TARGET: 'wait_target',
  PHASE_SETTLE: 'settle',
  PHASE_HOLD: 'hold',

  running: false,
  completed: false,
  stepIndex: 0,
  steps: [],
  phase: null,
  phaseStartTime: null,
  testStartTime: null,
  testEndTime: null,
  timerInterval: null,
  segments: [],
  summary: null,
  _audioCtx: null,
  _lastBeepSec: null,
  _stepData: null,

  _getCfg() {
    const seqText = document.getElementById('stCfgSequence')?.value;
    return {
      sequence: parseStabilitySequence(seqText),
      holdS: parseFloat(document.getElementById('stCfgHold')?.value) || 180,
      settleS: parseFloat(document.getElementById('stCfgSettle')?.value) || 20,
      waitTargetS: parseFloat(document.getElementById('stCfgWaitTarget')?.value) || 30,
      prepareS: parseFloat(document.getElementById('stCfgPrepare')?.value) || 5,
      tag: (document.getElementById('stCfgTag')?.value || '').trim() || null,
      notes: (document.getElementById('stCfgNotes')?.value || '').trim() || null,
      featureSampleMs: 1000, // collect feature/prob stats at 1Hz to keep logs small
    };
  },

  start() {
    const cfg = this._getCfg();
    this.steps = cfg.sequence.map(t => ({ target: t }));
    this.running = true;
    this.completed = false;
    this.stepIndex = 0;
    this.phase = null;
    this.phaseStartTime = null;
    this.testStartTime = Date.now();
    this.testEndTime = null;
    this._lastBeepSec = null;
    this.segments = [];
    this.summary = null;
    this._stepData = null;

    fetch('../api/log_transition?action=new')
      .then(r => r.json())
      .then(d => {
        console.log('[StabilityTest] Novo log:', d.file);
        loadTransitionLogList();
      })
      .catch(err => console.warn('[StabilityTest] Falha ao criar log:', err));

    document.getElementById('stStartBtn').disabled = true;
    document.getElementById('stStopBtn').disabled = false;
    document.getElementById('stBadge').textContent = 'Rodando';
    document.getElementById('stBadge').className = 'ml-badge ml-badge-active';
    document.getElementById('stResults').innerHTML = '';
    document.getElementById('stSummarySection').style.display = 'none';
    const abs = document.getElementById('olAbsorbSection');
    if (abs) { abs.style.display = 'none'; abs.innerHTML = ''; }
    OnlineLearning.clearPendingSession();

    this._buildStepBar();
    this._updateGlobalProgress();

    if (window.fanClassifier) window.fanClassifier.reset();

    // First step starts directly waiting for target (no countdown)
    this._startPhase(this.PHASE_WAIT_TARGET, { commandNow: false });
    this.timerInterval = setInterval(() => this._tick(), 200);
  },

  stop() {
    this.running = false;
    this.testEndTime = Date.now();
    clearInterval(this.timerInterval);
    this.timerInterval = null;

    document.getElementById('stStartBtn').disabled = false;
    document.getElementById('stStopBtn').disabled = true;
    document.getElementById('stBadge').textContent = 'Parado';
    document.getElementById('stBadge').className = 'ml-badge ml-badge-offline';
    this._setInstruction('Teste interrompido (log nao salvo)', 'rgba(255,255,255,0.4)', '');
    document.getElementById('stTimer').textContent = '--';
    this._updateGlobalProgress();
    console.log('[StabilityTest] Teste interrompido manualmente - log descartado.');
  },

  _beep(freq, durationMs) {
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = this._audioCtx.createOscillator();
      const gain = this._audioCtx.createGain();
      osc.connect(gain);
      gain.connect(this._audioCtx.destination);
      osc.frequency.value = freq;
      gain.gain.value = 0.12;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, this._audioCtx.currentTime + durationMs / 1000);
      osc.stop(this._audioCtx.currentTime + durationMs / 1000);
    } catch (e) { /* audio not supported */ }
  },

  _colors() {
    const c = {};
    _getModelLabels().forEach(l => { c[l] = _classColor(l); });
    return c;
  },

  _buildStepBar() {
    const bar = document.getElementById('stStepBar');
    if (!bar) return;
    bar.innerHTML = this.steps.map((s, i) => {
      const c = _classColor(s.target);
      return `<div id="stStep${i}" style="flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,0.1);position:relative;">
        <div style="position:absolute;inset:0;border-radius:3px;background:${c};opacity:0;transition:opacity 0.3s;" id="stStepFill${i}"></div>
        <div style="position:absolute;top:10px;left:0;right:0;text-align:center;font-size:0.55rem;color:rgba(255,255,255,0.4);">${_classShort(s.target)}</div>
      </div>`;
    }).join('');
  },

  _markStep(index, status) {
    const fill = document.getElementById(`stStepFill${index}`);
    if (!fill) return;
    if (status === 'active') { fill.style.opacity = '0.5'; fill.style.animation = 'mlGradient 1s ease infinite'; }
    else if (status === 'done') { fill.style.opacity = '1'; fill.style.animation = 'none'; }
    else { fill.style.opacity = '0'; fill.style.animation = 'none'; }
  },

  _updateGlobalProgress() {
    const total = this.steps.length;
    const done = Math.min(this.stepIndex, total);
    const pct = total ? (done / total * 100).toFixed(0) : '0';
    const fill = document.getElementById('stProgressFill');
    const text = document.getElementById('stProgressText');
    const elapsed = document.getElementById('stElapsedTime');
    const rangeEl = document.getElementById('stTimeRange');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = `Etapa ${done}/${total}`;
    if (elapsed && this.testStartTime) {
      const secs = Math.floor((Date.now() - this.testStartTime) / 1000);
      const m = String(Math.floor(secs / 60)).padStart(2, '0');
      const s = String(secs % 60).padStart(2, '0');
      elapsed.textContent = `${m}:${s}`;
    }
    if (rangeEl && this.testStartTime) {
      const fmt = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const cfg = this._getCfg();
      const n = Math.max(0, this.steps.length || 0);
      const perStepS =
        Math.max(0, cfg.waitTargetS || 0) +
        Math.max(0, cfg.settleS || 0) +
        Math.max(0, cfg.holdS || 0);
      const maxTotalS =
        (n > 0 ? perStepS : 0) +
        Math.max(0, n - 1) * (Math.max(0, cfg.prepareS || 0) + perStepS);
      const predictedEnd = this.testStartTime + (maxTotalS * 1000);
      const startStr = fmt(this.testStartTime);
      const endStr = this.testEndTime ? fmt(this.testEndTime) : '--';
      const predStr = Number.isFinite(predictedEnd) ? fmt(predictedEnd) : '--';
      rangeEl.textContent = `Inicio: ${startStr} | Fim: ${endStr} | Prev max: ${predStr}`;
    } else if (rangeEl) {
      rangeEl.textContent = '';
    }
  },

  _setInstruction(text, color, info) {
    const el = document.getElementById('stInstruction');
    if (el) { el.innerHTML = text; el.style.color = color; }
    const infoEl = document.getElementById('stPhaseInfo');
    if (infoEl) infoEl.textContent = info;
  },

  _startPhase(phase, opts = {}) {
    const cfg = this._getCfg();
    this.phase = phase;
    this.phaseStartTime = Date.now();
    this._lastBeepSec = null;

    const step = this.steps[this.stepIndex];
    if (!step) return;

    const colors = this._colors();
    this._markStep(this.stepIndex, 'active');
    this._updateGlobalProgress();

    if (phase === this.PHASE_PREPARE) {
      this._setInstruction(
        `Prepare-se para mudar para ${step.target}`,
        'rgba(255,255,255,0.6)',
        `Etapa ${this.stepIndex + 1}/${this.steps.length} - Contagem regressiva`
      );
    } else if (phase === this.PHASE_WAIT_TARGET) {
      if (opts.commandNow) {
        this._beep(880, 300);
      }
      this._stepData = {
        target: step.target,
        step_started_at: Date.now(),
        command_at: opts.commandAt || Date.now(),
        target_first_seen_at: null,
        wait_timeout_s: cfg.waitTargetS,
        wait_timeout_triggered: false,
        wait_timeout_at: null,
        wait_elapsed_s: null,
        settle_started_at: null,
        hold_started_at: null,
        hold_ended_at: null,
        tick_n: 0,
        confirmed_counts: Object.fromEntries(_getModelLabels().map(l => [l, 0])),
        raw_counts: Object.fromEntries(_getModelLabels().map(l => [l, 0])),
        flips: 0,
        flip_pairs: {},
        last_confirmed: null,
        gate_active: 0,
        confidence_samples: [],
        gap_samples: [],
        entropy_samples: [],
        feature_samples_n: 0,
        // Raw axis sampling during HOLD for reference baselines (used by Online Learning UI).
        axis_values: {
          accel_x_g: [],
          accel_y_g: [],
          accel_z_g: [],
          gyro_x_dps: [],
          gyro_y_dps: [],
          gyro_z_dps: [],
          vibration_dps: [],
        },
        feature_values: {}, // feature -> []
        feature_stats: {},  // feature -> { n, mean, std }
        feature_names: window.fanClassifier?.classifier?.model?.features || null,
        _last_feature_sample_at: 0,
      };
      this._setInstruction(
        `Coloque em ${step.target} e aguarde`,
        colors[step.target] || '#00d9ff',
        'Aguardando o classificador confirmar o alvo...'
      );
    } else if (phase === this.PHASE_SETTLE) {
      const timeoutNote = this._stepData?.wait_timeout_triggered ? ' | TIMEOUT: alvo não confirmado' : '';
      this._setInstruction(
        `Settle: ${step.target}`,
        colors[step.target] || '#00d9ff',
        `Ignorando ${cfg.settleS}s iniciais para evitar transiente${timeoutNote}`
      );
    } else if (phase === this.PHASE_HOLD) {
      const timeoutNote = this._stepData?.wait_timeout_triggered ? ' | TIMEOUT: alvo não confirmado' : '';
      this._setInstruction(
        `Hold: ${step.target}`,
        colors[step.target] || '#00d9ff',
        `Coletando por ${cfg.holdS}s${timeoutNote}`
      );
    }
  },

  _tick() {
    if (!this.running) return;
    const cfg = this._getCfg();
    const now = Date.now();
    const step = this.steps[this.stepIndex];
    if (!step) return;

    this._updateGlobalProgress();

    const pred = window.fanClassifier?.lastPrediction;
    const currentClass = pred?.confirmedState || pred?.prediction || '--';
    const classEl = document.getElementById('stCurrentClass');
    if (classEl) {
      classEl.textContent = currentClass;
      classEl.className = '';
      if (currentClass !== '--') classEl.classList.add('state-' + String(currentClass).toLowerCase());
    }

    const timerEl = document.getElementById('stTimer');
    const elapsed = (now - this.phaseStartTime) / 1000;

    if (this.phase === this.PHASE_PREPARE) {
      const remaining = Math.max(0, cfg.prepareS - elapsed);
      if (remaining > 3) {
        timerEl.textContent = Math.ceil(remaining) + 's';
        timerEl.style.color = 'rgba(255,255,255,0.6)';
      } else if (remaining > 0) {
        const sec = Math.ceil(remaining);
        timerEl.textContent = sec;
        timerEl.style.color = '#ffc107';
        timerEl.style.fontSize = '4rem';
        if (this._lastBeepSec !== sec) {
          this._lastBeepSec = sec;
          this._beep(sec === 1 ? 660 : 440, 150);
        }
      }
      if (remaining <= 0) {
        if (timerEl) timerEl.style.fontSize = '3rem';
        this._startPhase(this.PHASE_WAIT_TARGET, { commandNow: true, commandAt: now });
      }
      return;
    }

    if (this.phase === this.PHASE_WAIT_TARGET) {
      // Show time since command
      const sinceCmd = this._stepData?.command_at ? (now - this._stepData.command_at) / 1000 : elapsed;
      timerEl.textContent = sinceCmd.toFixed(1) + 's';
      timerEl.style.color = '#00d9ff';

      const colors = this._colors();
      const infoEl = document.getElementById('stPhaseInfo');
      if (infoEl) {
        const maxWait = cfg.waitTargetS != null ? cfg.waitTargetS : null;
        infoEl.textContent = `Aguardando alvo... (atual: ${currentClass})` + (maxWait ? ` | max: ${maxWait}s` : '');
      }

      if (currentClass === step.target) {
        if (this._stepData && !this._stepData.target_first_seen_at) {
          this._stepData.target_first_seen_at = now;
          this._stepData.settle_started_at = now;
        }
        if (cfg.settleS > 0) {
          this._startPhase(this.PHASE_SETTLE);
        } else {
          if (this._stepData) this._stepData.hold_started_at = now;
          this._startPhase(this.PHASE_HOLD);
        }
      }

      // Timeout: proceed even if classifier didn't confirm target
      if (cfg.waitTargetS > 0 && sinceCmd >= cfg.waitTargetS && currentClass !== step.target) {
        if (this._stepData && !this._stepData.wait_timeout_triggered) {
          this._stepData.wait_timeout_triggered = true;
          this._stepData.wait_timeout_at = now;
          this._stepData.wait_elapsed_s = +sinceCmd.toFixed(1);
          if (!this._stepData.settle_started_at) this._stepData.settle_started_at = now;
        }
        if (cfg.settleS > 0) {
          this._startPhase(this.PHASE_SETTLE);
        } else {
          if (this._stepData && !this._stepData.hold_started_at) this._stepData.hold_started_at = now;
          this._startPhase(this.PHASE_HOLD);
        }
      }
      return;
    }

    if (this.phase === this.PHASE_SETTLE) {
      const remaining = Math.max(0, cfg.settleS - elapsed);
      timerEl.textContent = Math.ceil(remaining) + 's';
      timerEl.style.color = remaining > 0 ? 'rgba(255,255,255,0.6)' : '#00ff88';
      if (remaining <= 0) {
        if (this._stepData) this._stepData.hold_started_at = now;
        this._startPhase(this.PHASE_HOLD);
      }
      return;
    }

    if (this.phase === this.PHASE_HOLD) {
      const remaining = Math.max(0, cfg.holdS - elapsed);
      timerEl.textContent = Math.ceil(remaining) + 's';
      timerEl.style.color = remaining > cfg.holdS * 0.4 ? '#00ff88' : remaining > cfg.holdS * 0.15 ? '#ffc107' : '#ff5252';

      this._collectHoldTick(pred, currentClass, now, cfg);

      if (remaining <= 0) {
        this._finishSegment(now);
        this.stepIndex++;
        if (this.stepIndex < this.steps.length) {
          this._startPhase(this.PHASE_PREPARE);
        } else {
          this._finishTest();
        }
      }
    }
  },

  _collectHoldTick(pred, currentClass, now, cfg) {
    if (!this._stepData) return;
    if (!pred || pred.status !== 'ok') return;

    // Counts every tick (200ms)
    this._stepData.tick_n++;
    if (this._stepData.confirmed_counts[currentClass] != null) this._stepData.confirmed_counts[currentClass]++;

    const raw = pred.rawPrediction;
    if (raw && this._stepData.raw_counts[raw] != null) this._stepData.raw_counts[raw]++;

    // Flips (confirmedState changes)
    if (this._stepData.last_confirmed && currentClass !== this._stepData.last_confirmed) {
      this._stepData.flips++;
      const key = `${this._stepData.last_confirmed}->${currentClass}`;
      this._stepData.flip_pairs[key] = (this._stepData.flip_pairs[key] || 0) + 1;
    }
    this._stepData.last_confirmed = currentClass;

    if (pred.gateActive) this._stepData.gate_active++;

    // Raw axis sampling for per-class baselines (every tick in HOLD, independent of feature sample rate).
    const lp = lastPayload;
    if (lp && this._stepData.axis_values) {
      const axes = this._stepData.axis_values;
      const ax = lp.accel_x_g;
      const ay = lp.accel_y_g;
      const az = lp.accel_z_g;
      const gx = lp.gyro_x_dps;
      const gy = lp.gyro_y_dps;
      const gz = lp.gyro_z_dps;
      const vib = lp.vibration_dps != null ? lp.vibration_dps : lp.vibration;

      if (Number.isFinite(ax)) axes.accel_x_g.push(ax * G_TO_MS2);
      if (Number.isFinite(ay)) axes.accel_y_g.push(ay * G_TO_MS2);
      if (Number.isFinite(az)) axes.accel_z_g.push(az * G_TO_MS2);
      if (Number.isFinite(gx)) axes.gyro_x_dps.push(gx);
      if (Number.isFinite(gy)) axes.gyro_y_dps.push(gy);
      if (Number.isFinite(gz)) axes.gyro_z_dps.push(gz);
      if (Number.isFinite(vib)) axes.vibration_dps.push(vib);
    }

    // Feature/prob sampling at 1Hz
    if (now - this._stepData._last_feature_sample_at < cfg.featureSampleMs) return;
    this._stepData._last_feature_sample_at = now;

    this._stepData.feature_samples_n++;
    this._stepData.confidence_samples.push(pred.confidence);
    this._stepData.gap_samples.push(pred.confidenceGap);
    const ent = entropyOfProbs(pred.smoothedProbabilities);
    if (ent != null) this._stepData.entropy_samples.push(ent);

    const features = pred.features || null;
    const featureNames = Array.isArray(this._stepData.feature_names)
      ? this._stepData.feature_names
      : (features ? Object.keys(features) : []);

    for (const fname of featureNames) {
      const v = features ? features[fname] : null;
      if (!Number.isFinite(v)) continue;
      if (!this._stepData.feature_values[fname]) this._stepData.feature_values[fname] = [];
      this._stepData.feature_values[fname].push(v);
    }
  },

  _finishSegment(now) {
    if (!this._stepData) return;
    const cfg = this._getCfg();
    const step = this.steps[this.stepIndex];
    const colors = this._colors();

    this._stepData.hold_ended_at = now;

    // Basic ratios
    const tickN = this._stepData.tick_n || 0;
    const target = step.target;
    const targetCount = tickN ? (this._stepData.confirmed_counts[target] || 0) : 0;
    const targetRatio = tickN ? targetCount / tickN : null;

    const confirmedCounts = this._stepData.confirmed_counts || {};
    const dom = Object.entries(confirmedCounts).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0] || [null, 0];
    const dominantState = dom[0] || null;
    const dominantRatio = tickN ? (dom[1] || 0) / tickN : null;

    const holdS = cfg.holdS;
    const flipsPerMin = holdS > 0 ? (this._stepData.flips / (holdS / 60)) : null;

    // Numeric summaries
    const conf = summarizeNumeric(this._stepData.confidence_samples);
    const gap = summarizeNumeric(this._stepData.gap_samples);
    const ent = summarizeNumeric(this._stepData.entropy_samples);

    // Feature stats (mean/std per feature)
    const featStats = {};
    for (const [fname, vals] of Object.entries(this._stepData.feature_values || {})) {
      const st = summarizeNumeric(vals);
      if (!st || st.n < 2 || st.mean == null) continue;
      featStats[fname] = {
        n: st.n,
        mean: st.mean,
        std: st.std,
      };
    }
    this._stepData.feature_stats = featStats;

    // Axis stats (mean/std/min/max/rms) to support "Referência (Adaptado)" after absorption.
    const axisStats = {};
    for (const [axis, vals] of Object.entries(this._stepData.axis_values || {})) {
      const st = summarizeNumeric(vals);
      if (!st || st.n < 2 || st.mean == null) continue;
      axisStats[axis] = {
        n: st.n,
        mean: st.mean,
        std: st.std,
        // Keep same keys used by config/eda_baselines_per_class.json for reuse in the dashboard UI.
        rms: Math.sqrt((st.mean ** 2) + (st.std ** 2)),
        min: st.min,
        max: st.max,
      };
    }
    this._stepData.axis_stats = axisStats;

    const timeToTarget = (this._stepData.target_first_seen_at && this._stepData.command_at)
      ? +((this._stepData.target_first_seen_at - this._stepData.command_at) / 1000).toFixed(1)
      : null;
    const waitTimeoutTriggered = !!this._stepData.wait_timeout_triggered;
    const waitTimeoutAtIso = this._stepData.wait_timeout_at ? new Date(this._stepData.wait_timeout_at).toISOString() : null;
    const targetFirstSeenIso = this._stepData.target_first_seen_at ? new Date(this._stepData.target_first_seen_at).toISOString() : null;
    const settleStartedIso = this._stepData.settle_started_at ? new Date(this._stepData.settle_started_at).toISOString() : null;

    const seg = {
      target,
      tick_n: tickN,
      feature_samples_n: this._stepData.feature_samples_n || 0,
      confirmed_counts: confirmedCounts,
      raw_counts: this._stepData.raw_counts,
      target_ratio: targetRatio,
      dominant_state: dominantState,
      dominant_ratio: dominantRatio,
      flips: this._stepData.flips,
      flips_per_min: flipsPerMin,
      flip_pairs: this._stepData.flip_pairs,
      gate_active_pct: tickN ? (this._stepData.gate_active / tickN) : null,
      confidence: conf,
      confidence_gap: gap,
      entropy: ent,
      time_to_target_s: timeToTarget,
      target_first_seen_at: targetFirstSeenIso,
      settle_started_at: settleStartedIso,
      wait_timeout_triggered: waitTimeoutTriggered,
      wait_timeout_s: this._stepData.wait_timeout_s ?? null,
      wait_elapsed_s: this._stepData.wait_elapsed_s ?? null,
      wait_timeout_at: waitTimeoutAtIso,
      feature_stats: featStats,
      axis_stats: axisStats,
      started_at: new Date(this._stepData.step_started_at).toISOString(),
      command_at: new Date(this._stepData.command_at).toISOString(),
      hold_started_at: this._stepData.hold_started_at ? new Date(this._stepData.hold_started_at).toISOString() : null,
      hold_ended_at: new Date(this._stepData.hold_ended_at).toISOString(),
      hold_s: holdS,
      settle_s: cfg.settleS,
    };

    this.segments.push(seg);
    this._markStep(this.stepIndex, 'done');

    // UI result line
    const resultsEl = document.getElementById('stResults');
    if (resultsEl) {
      const tsStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const accStr = targetRatio != null ? (targetRatio * 100).toFixed(1) + '%' : '--';
      const flipsStr = flipsPerMin != null ? flipsPerMin.toFixed(2) : '--';
      const c = targetRatio != null && targetRatio < 0.85 ? '#ffc107' : '#00ff88';
      const tttStr = timeToTarget != null
        ? (timeToTarget.toFixed(1) + 's')
        : waitTimeoutTriggered
          ? `TIMEOUT(${(this._stepData.wait_timeout_s ?? cfg.waitTargetS ?? '--')}s)`
          : '--';
      resultsEl.innerHTML += `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
        <span style="color:rgba(255,255,255,0.25);min-width:58px;font-size:0.65rem;font-family:'JetBrains Mono',monospace;">${tsStr}</span>
        <span style="color:rgba(255,255,255,0.3);min-width:20px;">#${this.stepIndex + 1}</span>
        <span class="state-${target.toLowerCase()}" style="min-width:70px;">${target}</span>
        <span style="color:${c};font-weight:700;min-width:80px;text-align:right;">${accStr}</span>
        <span style="color:rgba(255,255,255,0.35);font-size:0.7rem;min-width:85px;">flips/min: <span style="color:${colors[target] || '#00d9ff'};font-weight:700;">${flipsStr}</span></span>
        <span style="color:rgba(255,255,255,0.35);font-size:0.7rem;">T->alvo: ${tttStr}</span>
      </div>`;
    }
  },

  _finishTest() {
    this.running = false;
    this.testEndTime = Date.now();
    clearInterval(this.timerInterval);
    this.timerInterval = null;

    document.getElementById('stStartBtn').disabled = false;
    document.getElementById('stStopBtn').disabled = true;
    document.getElementById('stBadge').textContent = 'Concluido';
    document.getElementById('stBadge').className = 'ml-badge ml-badge-active';
    this._setInstruction('Teste concluido!', '#00ff88', 'Resultados salvos no log');
    document.getElementById('stTimer').textContent = '--';

    this.steps.forEach((_, i) => this._markStep(i, 'done'));
    this._updateGlobalProgress();

    this.completed = true;
    this._computeAndShowSummary();
    this._persistAll();

    // Online Learning: show absorption UI after soak test
    OnlineLearning._showAbsorbUI(this.segments, this._getCfg().tag);

    // Auto-Tune: show parameter recommendations
    showAutoTuneUI(this.segments);
  },

  _computeAndShowSummary() {
    const section = document.getElementById('stSummarySection');
    const content = document.getElementById('stSummaryContent');
    if (!section || !content) return;

    const cfg = this._getCfg();
    const endMs = this.testEndTime || Date.now();
    const durationS = this.testStartTime ? +((endMs - this.testStartTime) / 1000).toFixed(1) : null;

    // Aggregate feature stats by label (in case the sequence repeats labels)
    const labelAgg = {};
    const soakLabels = _getModelLabels();
    soakLabels.forEach(l => { labelAgg[l] = {}; });
    for (const seg of this.segments) {
      const label = seg.target;
      if (!labelAgg[label]) labelAgg[label] = {};
      const fs = seg.feature_stats || {};
      for (const [fname, st] of Object.entries(fs)) {
        if (!labelAgg[label][fname]) labelAgg[label][fname] = null;
        labelAgg[label][fname] = mergeStats(labelAgg[label][fname], st);
      }
    }

    const effects = {};
    const adjPairs = _getAdjacentPairs(soakLabels);
    const pairs = adjPairs.map(([a, b]) => [a, b, `${_classShort(a)}_vs_${_classShort(b)}`]);
    for (const [a, b, key] of pairs) {
      const fa = labelAgg[a] || {};
      const fb = labelAgg[b] || {};
      const feats = new Set([...Object.keys(fa), ...Object.keys(fb)]);
      const list = [];
      for (const fname of feats) {
        const d = cohensDFromStats(fa[fname], fb[fname]);
        if (d == null) continue;
        list.push({
          feature: fname,
          d,
          abs_d: Math.abs(d),
          mean_a: fa[fname]?.mean,
          mean_b: fb[fname]?.mean,
        });
      }
      list.sort((x, y) => (y.abs_d || 0) - (x.abs_d || 0));
      if (list.length) {
        effects[key] = {
          feature_count: list.length,
          small_abs_d_count: list.filter(x => x.abs_d < 0.2).length,
          top: list.slice(0, 10).map(x => ({
            feature: x.feature,
            d: x.d,
            mean_a: fa[x.feature]?.mean ?? null,
            mean_b: fb[x.feature]?.mean ?? null,
          })),
        };
      }
    }

    const summary = {
      test_duration_s: durationS,
      segments: this.segments,
      feature_effects: effects,
    };
    this.summary = summary;

    content.innerHTML = buildStabilitySummaryHtml({
      test_config: {
        sequence: cfg.sequence,
        hold_s: cfg.holdS,
        settle_s: cfg.settleS,
      },
      test_duration_s: durationS,
      segments: this.segments,
      summary: summary,
    });
    section.style.display = 'block';
  },

  _persistAll() {
    if (!this.completed) {
      console.log('[StabilityTest] Teste incompleto - log nao sera salvo.');
      return;
    }

    const cfg = this._getCfg();
    const endMs = this.testEndTime || Date.now();
    const testDurationS = this.testStartTime ? +((endMs - this.testStartTime) / 1000).toFixed(1) : null;

    const payload = {
      type: 'stability_test',
      test_time: new Date().toISOString(),
      test_started: this.testStartTime ? new Date(this.testStartTime).toISOString() : null,
      test_ended: this.testEndTime ? new Date(this.testEndTime).toISOString() : null,
      test_duration_s: testDurationS,
      test_tag: cfg.tag,
      test_notes: cfg.notes,
      trace: {
        tag: cfg.tag,
        notes: cfg.notes,
        configured_sample_rate_hz: lastServerConfig?.sample_rate ?? null,
        collection_id: lastPayload?.collection_id || null,
        training_sample_rate_hz: window.mlModelData?.eda_traceability?.sample_rate_hz || null,
      },
      model: {
        url: window.ML_CONFIG?.MODEL_URL || null,
        features_count: window.fanClassifier?.classifier?.featureNames?.length || null,
        model_version: window.mlModelData?.version || null,
        eda_version: window.mlModelData?.eda_traceability?.feature_config_version || null,
        eda_id: window.mlModelData?.eda_traceability?.eda_id || null,
        collection_ids: window.mlModelData?.eda_traceability?.collection_ids || null,
      },
      test_config: {
        sequence: cfg.sequence,
        hold_s: cfg.holdS,
        settle_s: cfg.settleS,
        wait_target_s: cfg.waitTargetS,
        prepare_s: cfg.prepareS,
        feature_sample_ms: cfg.featureSampleMs,
      },
      config: {
        window_size: window.ClassifierConfig?.WINDOW_SIZE,
        min_points: window.ClassifierConfig?.MIN_POINTS,
        smoothing_alpha: window.ClassifierConfig?.SMOOTHING_ALPHA,
        hysteresis_count: window.ClassifierConfig?.HYSTERESIS_COUNT,
        change_detect_ratio: window.ClassifierConfig?.CHANGE_DETECT_RATIO,
        change_detect_window: window.ClassifierConfig?.CHANGE_DETECT_WINDOW,
        fast_flush_keep: window.ClassifierConfig?.FAST_FLUSH_KEEP,
      },
      segments: this.segments,
      summary: this.summary,
    };

    fetch('../api/log_transition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json())
      .then((resp) => {
        console.log('[StabilityTest] Resultados completos salvos:', payload.summary);
        if (resp?.file) {
          loadTransitionLogFile(resp.file);
        } else {
          loadTransitionLogList();
        }
      }).catch(err => console.warn('[StabilityTest] Falha ao salvar:', err));
  },
};

// =============================================================================
// ONLINE LEARNING (BAYESIAN MODEL ADAPTATION)
// =============================================================================

const ONLINE_LEARNING_STORAGE_KEY = 'iot_fan_adapted_model';
const ONLINE_LEARNING_HISTORY_KEY = 'iot_fan_learning_history';

const OnlineLearning = {
  isAdapted: false,
  baseModel: null,
  history: [],
  pendingSession: null,

  /**
   * Called once after model loads. Stores base model and checks localStorage
   * for a previously adapted model.
   * @returns {object|null} adapted model to use, or null
   */
  initialize(baseModelData) {
    this.baseModel = JSON.parse(JSON.stringify(baseModelData));
    this.history = this._loadHistory();

    const adapted = this._loadAdaptedModel();
    if (adapted && adapted.version === baseModelData.version) {
      console.log('[OnlineLearning] Found adapted model in localStorage, loading...');
      return adapted;
    }

    if (adapted) {
      console.log('[OnlineLearning] Stored adapted model version mismatch, clearing.');
      this.history = [];
      this._clearStorage();
      return null;
    }

    // If there's no adapted model but we have history, it's stale (e.g. after a reset).
    if (this.history.length) {
      this.history = [];
      this._clearStorage();
    }
    return null;
  },

  /**
   * Extract per-class feature stats from completed soak test segments.
   * Returns { className: { featureName: { n, mean, std } } } or null.
   */
  extractSessionStats(segments) {
    if (!Array.isArray(segments) || !segments.length) return null;

    const labelAgg = {};
    for (const seg of segments) {
      const label = seg.target;
      if (!label) continue;
      if (!labelAgg[label]) labelAgg[label] = {};

      const fs = seg.feature_stats || {};
      for (const [fname, st] of Object.entries(fs)) {
        if (!st || st.n < 2) continue;
        if (!labelAgg[label][fname]) {
          labelAgg[label][fname] = { n: st.n, mean: st.mean, std: st.std };
        } else {
          labelAgg[label][fname] = mergeStats(labelAgg[label][fname], st);
        }
      }
    }

    const classesWithData = Object.keys(labelAgg).filter(
      label => Object.keys(labelAgg[label]).length > 0
    );
    if (classesWithData.length < 2) return null;
    return labelAgg;
  },

  /**
   * Extract per-class RAW axis baselines from soak test segments.
   * Format is compatible with config/eda_baselines_per_class.json "classes".
   *
   * Returns:
   * {
   *   LOW: { n, accel_x_g:{mean,std,rms,min,max}, ... },
   *   MEDIUM: { ... },
   *   HIGH: { ... }
   * }
   */
  extractAxisBaselines(segments) {
    if (!Array.isArray(segments) || !segments.length) return null;

    const out = {};
    for (const seg of segments) {
      const label = seg?.target;
      const axes = seg?.axis_stats;
      if (!label || !axes || typeof axes !== 'object') continue;
      if (!out[label]) out[label] = { n: null };

      for (const [axisKey, st] of Object.entries(axes)) {
        if (!st || !Number.isFinite(st.n) || st.n < 2) continue;
        if (!Number.isFinite(st.mean) || !Number.isFinite(st.std)) continue;

        if (!out[label][axisKey]) {
          out[label][axisKey] = {
            n: st.n,
            mean: st.mean,
            std: st.std,
            rms: Number.isFinite(st.rms) ? st.rms : Math.sqrt((st.mean ** 2) + (st.std ** 2)),
            min: Number.isFinite(st.min) ? st.min : null,
            max: Number.isFinite(st.max) ? st.max : null,
          };
          continue;
        }

        const cur = out[label][axisKey];
        const merged = mergeStats(
          { n: cur.n, mean: cur.mean, std: cur.std },
          { n: st.n, mean: st.mean, std: st.std }
        );
        cur.n = merged.n;
        cur.mean = merged.mean;
        cur.std = merged.std;
        cur.rms = Math.sqrt((cur.mean ** 2) + (cur.std ** 2));
        if (Number.isFinite(st.min)) cur.min = (cur.min == null) ? st.min : Math.min(cur.min, st.min);
        if (Number.isFinite(st.max)) cur.max = (cur.max == null) ? st.max : Math.max(cur.max, st.max);
      }
    }

    const labelsWithData = Object.keys(out).filter(
      label => Object.keys(out[label] || {}).some(k => k !== 'n')
    );
    if (labelsWithData.length < 2) return null;

    // Set per-class sample count (min across axes, when available).
    for (const label of labelsWithData) {
      const counts = Object.entries(out[label] || {})
        .filter(([k, v]) => k !== 'n' && v && Number.isFinite(v.n))
        .map(([, v]) => v.n);
      out[label].n = counts.length ? Math.min(...counts) : null;
    }

    return out;
  },

  /**
   * Preview what the update would do without applying it.
   */
  preview(segments, lambda = 0.9) {
    const sessionStats = this.extractSessionStats(segments);
    if (!sessionStats) return null;

    const modelCopy = window.fanClassifier.exportModel();
    if (!modelCopy) return null;

    const tempClassifier = new GaussianNBClassifier();
    tempClassifier.load(modelCopy);
    const delta = tempClassifier.bayesianUpdate(sessionStats, lambda);

    return { delta, sessionStats, classesWithData: Object.keys(sessionStats) };
  },

  /**
   * Apply the Bayesian update to the live classifier.
   * @returns {object|null} delta or null on failure
   */
  absorb(segments, lambda = 0.9, tag = null) {
    const sessionStats = this.extractSessionStats(segments);
    if (!sessionStats) {
      console.warn('[OnlineLearning] No valid session stats to absorb.');
      return null;
    }

    try {
      const delta = window.fanClassifier.bayesianUpdate(sessionStats, lambda);
      this.isAdapted = true;

      const classesWithData = Object.keys(sessionStats).filter(
        label => Object.keys(sessionStats[label]).length > 0
      );

      const historyEntry = {
        timestamp: new Date().toISOString(),
        lambda,
        classes: classesWithData,
        featureCount: Object.keys(delta[classesWithData[0]] || {}).length,
        tag: tag || null,
        server_export: { status: 'pending' },
      };
      this.history.push(historyEntry);

      // Attach traceability + per-class axis baselines to the live model for persistence.
      const modelObj = window.fanClassifier?.classifier?.model;
      if (modelObj && typeof modelObj === 'object') {
        modelObj._adapted = true;
        modelObj._base_version = this.baseModel?.version || modelObj._base_version || 'unknown';
        modelObj._adaptation_history = this.history;
        modelObj._ol_last_absorb = {
          timestamp: historyEntry.timestamp,
          lambda,
          tag: tag || null,
          configured_sample_rate_hz: lastServerConfig?.sample_rate ?? null,
          collection_id: lastPayload?.collection_id || null,
        };

        const axisBaselines = this.extractAxisBaselines(segments);
        if (axisBaselines) {
          historyEntry.axis_ref = {
            status: 'ok',
            source: 'soak_test',
            classes: Object.keys(axisBaselines),
          };
          modelObj._ol_reference_baselines = {
            version: 1,
            generated_at: new Date().toISOString(),
            source: 'soak_test',
            tag: tag || null,
            configured_sample_rate_hz: lastServerConfig?.sample_rate ?? null,
            collection_id: lastPayload?.collection_id || null,
            classes: axisBaselines,
          };
        } else {
          // Avoid keeping stale adapted baselines from a previous absorption.
          historyEntry.axis_ref = {
            status: 'missing',
            message: 'Sessao sem axis_stats; referencias dos graficos permanecem do treino.',
          };
          if (modelObj._ol_reference_baselines) {
            delete modelObj._ol_reference_baselines;
          }
          clearAdaptedPerClassBaselines();
          injectPerClassReferenceStrips();
          updateRefMatchHighlight();
        }
      }

      // Also update the in-memory mlModelData to stay in sync
      const updated = window.fanClassifier.exportModel();
      if (updated) window.mlModelData = updated;

      // If the adapted model contains per-class baselines, switch the dashboard refs to "Adaptado".
      if (updated && setAdaptedPerClassBaselinesFromModel(updated)) {
        injectPerClassReferenceStrips();
        updateRefMatchHighlight();
      }

      this._saveAdaptedModel();
      this._saveHistory();
      this._updateBadge();
      this._updateHistoryInfo();
      updateModelPerformance(window.mlModelData);
      this.clearPendingSession();

      // Auto-export to server for traceability (non-blocking).
      if (updated) {
        const meta = {
          lambda,
          tag: tag || null,
          configured_sample_rate_hz: lastServerConfig?.sample_rate ?? null,
          collection_id: lastPayload?.collection_id || null,
          base_model_version: this.baseModel?.version || null,
          model_version: updated.version || null,
          classes: classesWithData,
        };
        this._exportToServer(updated, meta).then((resp) => {
          historyEntry.server_export = {
            status: 'ok',
            file: resp?.file || null,
            relative_path: resp?.relative_path || null,
            latest: resp?.latest || null,
          };
          this._saveHistory();
          this._updateHistoryInfo();
        }).catch((err) => {
          historyEntry.server_export = {
            status: 'error',
            message: String(err?.message || err || 'Falha ao exportar'),
          };
          this._saveHistory();
          this._updateHistoryInfo();
        });
      } else {
        historyEntry.server_export = { status: 'error', message: 'exportModel() retornou null' };
        this._saveHistory();
        this._updateHistoryInfo();
      }

      console.log(`[OnlineLearning] Model adapted. Lambda=${lambda}, classes=${classesWithData.join(',')}`);
      return delta;
    } catch (err) {
      console.error('[OnlineLearning] Absorb failed:', err);
      return null;
    }
  },

  /**
   * Reset to base model.
   */
  async resetToBase() {
    if (!this.baseModel) {
      console.warn('[OnlineLearning] No base model stored.');
      return false;
    }

    const baseCopy = JSON.parse(JSON.stringify(this.baseModel));
    const success = await window.fanClassifier.loadAdaptedModel(baseCopy);
    if (success) {
      window.mlModelData = JSON.parse(JSON.stringify(this.baseModel));
      this.isAdapted = false;
      this.history = [];
      this._clearStorage();
      this._updateBadge();
      this._updateHistoryInfo();
      updateModelPerformance(window.mlModelData);

      // Switch reference strips back to training baselines.
      clearAdaptedPerClassBaselines();
      injectPerClassReferenceStrips();
      updateRefMatchHighlight();

      console.log('[OnlineLearning] Reset to base model.');
    }
    return success;
  },

  /**
   * Export current adapted model as downloadable JSON file.
   */
  exportAdaptedModel() {
    const model = window.fanClassifier.exportModel();
    if (!model) return;

    model._adapted = true;
    model._adaptation_history = this.history;
    model._base_version = this.baseModel?.version || 'unknown';

    const blob = new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `adapted_model_${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  /**
   * Persist an adapted model JSON on the server for auditability.
   * This is best-effort: failures should not block adaptation.
   */
  async _exportToServer(modelObj, meta = {}) {
    const res = await fetch('../api/save_adapted_model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelObj, meta: meta || {} }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${txt}`.trim());
    }
    return res.json();
  },

  // --- UI methods ---

  setPendingSession(pending) {
    this.pendingSession = pending || null;
    this._renderPendingSession();
  },

  clearPendingSession() {
    this.pendingSession = null;
    this._renderPendingSession();
  },

  _renderPendingSession() {
    const textEl = document.getElementById('olPendingText');
    const badgeEl = document.getElementById('olPendingBadge');
    const clearBtn = document.getElementById('olClearPendingBtn');
    const goBtn = document.getElementById('olGoToSoakBtn');

    if (!textEl || !badgeEl) return;

    badgeEl.classList.remove('ol-pending-ok', 'ol-pending-warn', 'ol-pending-block');

    const p = this.pendingSession;
    if (!p) {
      badgeEl.textContent = 'Sem sessao';
      badgeEl.title = '';
      textEl.textContent = 'Rode o Soak Test para gerar uma sessao rotulada para adaptacao.';
      if (clearBtn) clearBtn.style.display = 'none';
      if (goBtn) goBtn.textContent = 'Ir para Soak';
      return;
    }

    const when = p.timestamp ? new Date(p.timestamp) : new Date();
    const d = when.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const t = when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const tag = p.tag ? `Tag: ${p.tag}` : 'Sem tag';
    const cls = Array.isArray(p.usableClasses) && p.usableClasses.length ? p.usableClasses.join(', ') : '--';
    textEl.textContent = `${tag} | Classes: ${cls} | ${d} ${t}`;

    const level = p.level || 'ok';
    if (level === 'ok') {
      badgeEl.textContent = 'Pronta';
      badgeEl.classList.add('ol-pending-ok');
    } else if (level === 'warn') {
      badgeEl.textContent = 'Atencao';
      badgeEl.classList.add('ol-pending-warn');
    } else {
      badgeEl.textContent = 'Bloqueada';
      badgeEl.classList.add('ol-pending-block');
    }

    const reasonParts = [];
    if (Array.isArray(p.blocks) && p.blocks.length) reasonParts.push(...p.blocks);
    if (Array.isArray(p.warnings) && p.warnings.length) reasonParts.push(...p.warnings);
    badgeEl.title = reasonParts.slice(0, 6).join(' | ');

    if (clearBtn) clearBtn.style.display = '';
    if (goBtn) goBtn.textContent = 'Ver/Absorver';
  },

  _assessSessionQuality(segments) {
    const segs = Array.isArray(segments) ? segments.filter(Boolean) : [];

    const holdS = segs[0]?.hold_s ?? 180;
    const expectedFeatCount = Array.isArray(window.mlModelData?.features) ? window.mlModelData.features.length : 0;
    const minSamples = Math.min(60, Math.max(15, Math.floor((holdS || 180) * 0.2)));
    const minFeatStats = expectedFeatCount
      ? Math.min(expectedFeatCount, Math.max(4, Math.floor(expectedFeatCount * 0.5)))
      : 6;

    const byLabel = {};
    for (const seg of segs) {
      const label = seg?.target;
      if (!label) continue;
      if (!byLabel[label]) byLabel[label] = { usable: [], warnings: [] };

      const sampleN = seg.feature_samples_n ?? 0;
      const featCount = Object.keys(seg.feature_stats || {}).length;
      const hardOk = (sampleN >= minSamples) && (featCount >= minFeatStats);
      if (hardOk) byLabel[label].usable.push(seg);

      const w = [];
      if (seg.target_ratio != null && seg.target_ratio < 0.9) {
        w.push(`instavel: alvo ${Math.round(seg.target_ratio * 100)}%`);
      }
      if (seg.dominant_state && seg.dominant_state !== label) {
        w.push(`dominante ${seg.dominant_state}`);
      }
      if (seg.flips_per_min != null && seg.flips_per_min > 10) {
        w.push(`muitos flips/min (${seg.flips_per_min.toFixed(1)})`);
      }
      if (sampleN < minSamples) {
        w.push(`poucos samples (${sampleN} < ${minSamples})`);
      }
      if (featCount < minFeatStats) {
        w.push(`poucas features (${featCount} < ${minFeatStats})`);
      }
      if (w.length) {
        byLabel[label].warnings.push(...w);
      }
    }

    const usableSegments = Object.values(byLabel).flatMap(v => v.usable);
    const usableStats = this.extractSessionStats(usableSegments);
    const usableClasses = usableStats ? Object.keys(usableStats) : [];
    const allClasses = Object.keys(byLabel);

    const blocks = [];
    if (usableClasses.length < 2) {
      blocks.push(`Dados insuficientes: precisa de >=2 classes com amostras suficientes (>=${minSamples}s e >=${minFeatStats} features).`);
    }

    const warnings = [];
    for (const [label, info] of Object.entries(byLabel)) {
      const uniq = Array.from(new Set(info.warnings));
      if (!uniq.length) continue;
      warnings.push(`${label}: ${uniq.slice(0, 4).join(', ')}${uniq.length > 4 ? ', ...' : ''}`);
    }

    const level = blocks.length ? 'block' : (warnings.length ? 'warn' : 'ok');

    return {
      level,
      blocks,
      warnings,
      minSamples,
      minFeatStats,
      usableSegments,
      usableClasses,
      allClasses,
    };
  },

  _showAbsorbUI(segments, sessionTag) {
    const container = document.getElementById('olAbsorbSection');
    if (!container) return;

    if (window.mlModelData?.type !== 'gaussian_nb') {
      container.style.display = 'none';
      return;
    }

    const quality = this._assessSessionQuality(segments);
    const pendingTs = new Date().toISOString();
    this.setPendingSession({
      timestamp: pendingTs,
      tag: sessionTag || null,
      level: quality.level,
      usableClasses: quality.usableClasses,
      warnings: quality.warnings,
      blocks: quality.blocks,
    });

    const segmentsForUpdate = quality.usableSegments;
    const sessionStats = this.extractSessionStats(segmentsForUpdate);
    const classesWithData = sessionStats ? Object.keys(sessionStats).filter(
      label => Object.keys(sessionStats[label]).length > 0
    ) : [];

    // Auto-suggest lambda based on drift divergence
    const suggestedLambda = sessionStats && window.fanClassifier?.computeSuggestedLambda
      ? window.fanClassifier.computeSuggestedLambda(sessionStats) : null;
    const defaultLambda = suggestedLambda ? suggestedLambda.lambda.toFixed(2) : '0.90';

    const qColor = quality.level === 'ok' ? '#00ff88' : quality.level === 'warn' ? '#ffc107' : '#ff5252';
    const qLabel = quality.level === 'ok' ? 'OK' : quality.level === 'warn' ? 'ATENCAO' : 'BLOQUEADA';

    const allCls = (quality.allClasses && quality.allClasses.length) ? quality.allClasses.join(', ') : '--';
    const useCls = (classesWithData.length ? classesWithData.join(', ') : '--');

    const reasonLines = [];
    if (quality.blocks && quality.blocks.length) {
      for (const b of quality.blocks) {
        reasonLines.push(`<div style="color:#ff5252;">- ${b}</div>`);
      }
    }
    if (quality.warnings && quality.warnings.length) {
      for (const w of quality.warnings) {
        reasonLines.push(`<div style="color:#ffc107;">- ${w}</div>`);
      }
    }
    const reasonsHtml = reasonLines.length
      ? `
        <div style="margin-bottom:10px;padding:8px;border:1px solid rgba(255,255,255,0.1);border-radius:8px;background:rgba(255,255,255,0.03);">
          <div style="font-size:0.7rem;color:rgba(255,255,255,0.65);font-weight:600;margin-bottom:6px;">
            Checklist da sessao
          </div>
          <div style="font-size:0.65rem;color:rgba(255,255,255,0.55);display:flex;flex-direction:column;gap:3px;">
            ${reasonLines.join('')}
          </div>
          <div style="font-size:0.6rem;color:rgba(255,255,255,0.35);margin-top:6px;">
            Criterios: >=${quality.minSamples}s e >=${quality.minFeatStats} features por classe (min 2 classes).
          </div>
        </div>
      `
      : '';

    const needsConfirm = quality.level === 'warn';
    const hasStats = !!sessionStats;

    container.innerHTML = `
      <div style="border-top:1px solid rgba(255,255,255,0.1);padding-top:12px;margin-top:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
          <div style="font-size:0.85rem;font-weight:600;color:#00d9ff;">
            Aprendizado Online (Bayesiano)
          </div>
          <div style="font-size:0.7rem;font-weight:700;color:${qColor};letter-spacing:0.4px;">
            Qualidade: ${qLabel}
          </div>
        </div>
        <div style="font-size:0.7rem;color:rgba(255,255,255,0.5);margin-bottom:10px;">
          Absorver esta sessao para adaptar o modelo as condicoes atuais.<br>
          Classes (detectadas): <strong style="color:rgba(255,255,255,0.75);">${allCls}</strong><br>
          Classes (usaveis): <strong style="color:#00ff88;">${useCls}</strong>
        </div>
        ${reasonsHtml}

        ${hasStats ? `
          ${suggestedLambda ? `
            <div style="padding:6px 10px;margin-bottom:8px;border-radius:6px;background:rgba(0,217,255,0.06);border:1px solid rgba(0,217,255,0.15);font-size:0.72rem;">
              <span style="color:#00d9ff;font-weight:600;">Lambda sugerido: ${suggestedLambda.lambda.toFixed(2)}</span>
              <span style="color:rgba(255,255,255,0.5);margin-left:6px;">(${suggestedLambda.explanation} | div: ${suggestedLambda.divergence.toFixed(2)})</span>
            </div>
          ` : ''}
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <label style="color:rgba(255,255,255,0.6);font-size:0.75rem;white-space:nowrap;">
              Fator de esquecimento (&lambda;):
              <span id="olLambdaVal" style="color:#00d9ff;font-family:'JetBrains Mono',monospace;">${defaultLambda}</span>
            </label>
            <input type="range" id="olLambdaSlider" min="0.50" max="1.00" step="0.01" value="${defaultLambda}"
              style="flex:1;accent-color:#00d9ff;cursor:pointer;">
          </div>
          <div style="font-size:0.65rem;color:rgba(255,255,255,0.35);margin-bottom:10px;">
            &lambda;=1.0: peso igual para dados antigos e novos. &lambda;=0.5: dados novos contam ~2x mais.
          </div>
          <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
            <button class="btn" id="olPreviewBtn" style="background:rgba(0,217,255,0.15);border:1px solid rgba(0,217,255,0.4);color:#00d9ff;font-size:0.8rem;padding:5px 14px;border-radius:6px;cursor:pointer;">
              Pre-visualizar
            </button>
            <button class="btn" id="olAbsorbBtn" ${needsConfirm ? 'disabled' : ''} style="background:rgba(0,255,136,0.15);border:1px solid rgba(0,255,136,0.4);color:#00ff88;font-size:0.8rem;font-weight:700;padding:5px 14px;border-radius:6px;cursor:pointer;">
              Absorver Sessao
            </button>
          </div>
          ${needsConfirm ? `
            <div style="display:flex;align-items:flex-start;gap:8px;margin:6px 0 10px;">
              <input type="checkbox" id="olConfirmLabels" style="margin-top:2px;accent-color:#00ff88;cursor:pointer;">
              <label for="olConfirmLabels" style="color:rgba(255,255,255,0.6);font-size:0.7rem;cursor:pointer;">
                Confirmo que os rotulos do Soak Test estao corretos (${_getModelLabels().map(_classShort).join('/')}).
              </label>
            </div>
          ` : ''}
          <div id="olPreviewContent" style="display:none;margin-top:8px;"></div>
          <div id="olAbsorbResult" style="display:none;margin-top:8px;"></div>
        ` : `
          <div style="color:#ffc107;font-size:0.75rem;padding:8px;border:1px solid rgba(255,193,7,0.2);border-radius:8px;background:rgba(255,193,7,0.05);">
            Dados insuficientes para adaptacao. Rode o Soak Test novamente (ou aumente o tempo de Hold).
          </div>
        `}
      </div>
    `;
    container.style.display = 'block';

    if (!hasStats) {
      return;
    }

    // Lambda slider live update
    const slider = document.getElementById('olLambdaSlider');
    const valEl = document.getElementById('olLambdaVal');
    if (slider && valEl) {
      slider.addEventListener('input', () => {
        valEl.textContent = parseFloat(slider.value).toFixed(2);
      });
    }

    // Preview button
    const previewBtn = document.getElementById('olPreviewBtn');
    if (previewBtn) {
      previewBtn.addEventListener('click', () => {
        const lambda = parseFloat(slider.value);
        const result = this.preview(segmentsForUpdate, lambda);
        const previewEl = document.getElementById('olPreviewContent');
        if (!result) {
          previewEl.innerHTML = '<div style="color:#ff5252;font-size:0.75rem;">Falha ao gerar preview.</div>';
          previewEl.style.display = 'block';
          return;
        }
        previewEl.innerHTML = this._buildDeltaHtml(result.delta);
        previewEl.style.display = 'block';
      });
    }

    // Absorb button
    const absorbBtn = document.getElementById('olAbsorbBtn');
    if (absorbBtn) {
      const confirmEl = document.getElementById('olConfirmLabels');
      const updateAbsorbEnabled = () => {
        if (!confirmEl) return;
        absorbBtn.disabled = !confirmEl.checked;
        absorbBtn.style.opacity = confirmEl.checked ? '1' : '0.4';
        absorbBtn.style.cursor = confirmEl.checked ? 'pointer' : 'not-allowed';
      };
      if (confirmEl) {
        updateAbsorbEnabled();
        confirmEl.addEventListener('change', updateAbsorbEnabled);
      }

      absorbBtn.addEventListener('click', () => {
        if (confirmEl && !confirmEl.checked) return;
        const lambda = parseFloat(slider.value);
        const delta = this.absorb(segmentsForUpdate, lambda, sessionTag);
        const resultEl = document.getElementById('olAbsorbResult');
        if (delta) {
          resultEl.innerHTML = `
            <div style="color:#00ff88;font-size:0.8rem;font-weight:600;margin-bottom:6px;">
              Modelo adaptado com sucesso!
            </div>
            ${this._buildDeltaHtml(delta)}
          `;
          absorbBtn.disabled = true;
          absorbBtn.style.opacity = '0.4';
          absorbBtn.style.cursor = 'not-allowed';
        } else {
          resultEl.innerHTML = '<div style="color:#ff5252;font-size:0.8rem;">Falha na adaptacao.</div>';
        }
        resultEl.style.display = 'block';
      });
    }
  },

  _buildDeltaHtml(delta) {
    if (!delta) return '';
    const labels = Object.keys(delta);
    let html = '';

    for (const label of labels) {
      const features = delta[label];
      const featureNames = Object.keys(features);
      if (!featureNames.length) continue;

      const rows = featureNames.map(fname => {
        const d = features[fname];
        const meanPct = d.mean_before !== 0
          ? (((d.mean_after - d.mean_before) / Math.abs(d.mean_before)) * 100).toFixed(1)
          : '--';
        const meanColor = Math.abs(parseFloat(meanPct)) > 20 ? '#ffc107' : 'rgba(255,255,255,0.7)';
        return `<tr>
          <td style="font-size:0.65rem;color:rgba(255,255,255,0.6);text-align:left;">${fname}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:#00ff88;">${d.mean_before.toFixed(4)}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:#00ff88;">${d.mean_after.toFixed(4)}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:${meanColor};">${meanPct}%</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;">${d.count_before}&rarr;${d.count_after}</td>
        </tr>`;
      }).join('');

      html += `
        <div style="margin-bottom:8px;">
          <div style="font-size:0.75rem;font-weight:600;color:${_classColor(label)};margin-bottom:4px;">${_classShort(label)}</div>
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr>
              <th style="text-align:left;color:rgba(255,255,255,0.4);font-weight:400;font-size:0.6rem;padding:2px 4px;">Feature</th>
              <th style="color:rgba(255,255,255,0.4);font-weight:400;font-size:0.6rem;padding:2px 4px;">Antes</th>
              <th style="color:rgba(255,255,255,0.4);font-weight:400;font-size:0.6rem;padding:2px 4px;">Depois</th>
              <th style="color:rgba(255,255,255,0.4);font-weight:400;font-size:0.6rem;padding:2px 4px;">Var%</th>
              <th style="color:rgba(255,255,255,0.4);font-weight:400;font-size:0.6rem;padding:2px 4px;">Count</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }
    return html;
  },

  _updateBadge() {
    const badge = document.getElementById('olBadge');
    if (!badge) return;
    if (this.isAdapted) {
      badge.textContent = `Adaptado (${this.history.length}x)`;
      badge.className = 'ml-badge ml-badge-active';
    } else {
      badge.textContent = 'Modelo Base';
      badge.className = 'ml-badge ml-badge-offline';
    }
  },

  _updateHistoryInfo() {
    const el = document.getElementById('olHistoryInfo');
    const metaEl = document.getElementById('olSummaryMeta');
    const detailsEl = document.getElementById('olDetails');

    if (metaEl) {
      if (!this.history.length) {
        metaEl.textContent = '0 sessoes';
        metaEl.removeAttribute('title');
      } else {
        const lastEntry = this.history[this.history.length - 1];
        const lastDate = new Date(lastEntry.timestamp);
        const d = lastDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const t = lastDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        metaEl.textContent = `${this.history.length}x | ${d} ${t}`;
        metaEl.title = `Ultima sessao: ${lastDate.toLocaleString('pt-BR')}` +
          (lastEntry.tag ? ` | Tag: ${lastEntry.tag}` : '');
      }
    }

    // Keep OL open when adapted so reset/export stay discoverable.
    if (detailsEl && typeof detailsEl.open === 'boolean') {
      detailsEl.open = !!this.isAdapted;
    }

    if (!el) return;
    if (!this.history.length) {
      el.textContent = 'Nenhuma sessao absorvida ainda.';
      const resetBtn = document.getElementById('olResetBtn');
      if (resetBtn) resetBtn.disabled = true;
      return;
    }
    const lastEntry = this.history[this.history.length - 1];
    const lastDate = new Date(lastEntry.timestamp);

    let serverHtml = '';
    const exp = lastEntry.server_export || null;
    if (exp?.status === 'pending') {
      serverHtml = ` | Servidor: <strong style="color:#ffc107;">salvando...</strong>`;
    } else if (exp?.status === 'ok') {
      const fileRaw = exp.file ? String(exp.file) : '';
      const file = escapeHtml(fileRaw.length > 56 ? (fileRaw.slice(0, 53) + '...') : fileRaw);
      serverHtml = ` | Servidor: <strong style="color:#0f766e;">salvo</strong>` + (file ? ` <span style="color:rgba(15,23,42,0.55);font-family:'JetBrains Mono',monospace;font-size:0.65rem;">${file}</span>` : '');
    } else if (exp?.status === 'error') {
      serverHtml = ` | Servidor: <strong style="color:#ff5252;">falha</strong>`;
    }

    let refsHtml = '';
    const axisRef = lastEntry.axis_ref || null;
    if (axisRef?.status === 'ok') {
      refsHtml = ` | Refs (graficos): <strong style="color:#0f766e;">adaptado</strong>`;
    } else if (axisRef?.status === 'missing') {
      refsHtml = ` | Refs (graficos): <strong style="color:#92400e;">treino</strong>` +
        ` <span style="color:rgba(15,23,42,0.55);font-size:0.65rem;">(sem axis_stats)</span>`;
    }

    el.innerHTML = `Sessoes absorvidas: <strong>${this.history.length}</strong> | ` +
      `Ultima: ${lastDate.toLocaleDateString('pt-BR')} ${lastDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` +
      (lastEntry.tag ? ` | Tag: ${escapeHtml(lastEntry.tag)}` : '') +
      serverHtml +
      refsHtml;

    const resetBtn = document.getElementById('olResetBtn');
    if (resetBtn) resetBtn.disabled = !this.isAdapted;
  },

  // --- localStorage helpers ---

  _saveAdaptedModel() {
    try {
      const model = window.fanClassifier.exportModel();
      if (model) localStorage.setItem(ONLINE_LEARNING_STORAGE_KEY, JSON.stringify(model));
    } catch (e) {
      console.warn('[OnlineLearning] Failed to save to localStorage:', e);
    }
  },

  _loadAdaptedModel() {
    try {
      const raw = localStorage.getItem(ONLINE_LEARNING_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  _saveHistory() {
    try {
      localStorage.setItem(ONLINE_LEARNING_HISTORY_KEY, JSON.stringify(this.history));
    } catch (e) { /* ignore */ }
  },

  _loadHistory() {
    try {
      const raw = localStorage.getItem(ONLINE_LEARNING_HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  },

  _clearStorage() {
    localStorage.removeItem(ONLINE_LEARNING_STORAGE_KEY);
    localStorage.removeItem(ONLINE_LEARNING_HISTORY_KEY);
  },
};

// =============================================================================
// MODEL HEALTH CHECK
// Runs automatically after first prediction to detect drift from trained model.
// =============================================================================

const ModelHealthCheck = {
  COLLECTION_DURATION_MS: 15000,
  _collecting: false,
  _driftSamples: [],
  _result: null,
  _displayed: false,
  _startTime: 0,

  start() {
    if (this._collecting || this._displayed) return;
    this._collecting = true;
    this._driftSamples = [];
    this._startTime = Date.now();
    console.log('[HealthCheck] Starting drift collection (15s)...');
    this._updateUI('collecting');
  },

  onPrediction(prediction) {
    if (!this._collecting) return;
    if (prediction.status !== 'ok' || !prediction.features) return;

    const drift = window.fanClassifier?.computeDrift(prediction.features);
    if (drift) {
      this._driftSamples.push(drift);
    }

    if (Date.now() - this._startTime >= this.COLLECTION_DURATION_MS) {
      this._finishCollection();
    }
  },

  _finishCollection() {
    this._collecting = false;
    if (this._driftSamples.length === 0) {
      console.log('[HealthCheck] No samples collected.');
      return;
    }

    // Aggregate mean z-scores per class across all samples
    const labels = _getModelLabels();
    const perClass = {};

    for (const label of labels) {
      const zScores = this._driftSamples
        .map(s => s.perClass[label]?.meanZ)
        .filter(v => v != null && Number.isFinite(v));
      if (zScores.length === 0) continue;
      const avg = zScores.reduce((a, b) => a + b, 0) / zScores.length;
      perClass[label] = { avgMeanZ: avg };
    }

    // Best class = lowest avgMeanZ
    const sorted = Object.entries(perClass).sort((a, b) => a[1].avgMeanZ - b[1].avgMeanZ);
    const bestClass = sorted.length > 0 ? sorted[0][0] : null;
    const bestZ = sorted.length > 0 ? sorted[0][1].avgMeanZ : Infinity;

    // Overall health: best class's avgMeanZ
    let health, color, label;
    if (bestZ < 1.5) {
      health = 'green';
      color = '#00ff88';
      label = 'Modelo OK';
    } else if (bestZ < 2.5) {
      health = 'yellow';
      color = '#ffc107';
      label = 'Drift Moderado';
    } else {
      health = 'red';
      color = '#ff5252';
      label = 'Drift Severo';
    }

    // Overlap detection
    const overlapCount = this._driftSamples.filter(s => s.worstOverlap).length;
    const overlapRatio = overlapCount / this._driftSamples.length;

    this._result = {
      health, color, label,
      bestClass, bestZ,
      perClass,
      overlapRatio,
      sampleCount: this._driftSamples.length,
    };

    this._displayed = true;
    this._updateUI('result');
    console.log(`[HealthCheck] Result: ${health} (bestZ=${bestZ.toFixed(2)}, bestClass=${bestClass}, overlap=${(overlapRatio * 100).toFixed(0)}%)`);
  },

  _updateUI(mode) {
    const el = document.getElementById('mlHealthCheck');
    if (!el) return;

    if (mode === 'collecting') {
      el.style.display = 'block';
      el.innerHTML = `
        <div style="padding:6px 10px;margin-top:8px;border-radius:6px;background:rgba(0,217,255,0.06);border:1px solid rgba(0,217,255,0.15);font-size:0.75rem;color:rgba(255,255,255,0.6);">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#00d9ff;margin-right:6px;animation:pulse 1s infinite;"></span>
          Health Check: coletando dados (15s)...
        </div>`;
      return;
    }

    if (mode === 'result' && this._result) {
      const r = this._result;
      const perClassHtml = Object.entries(r.perClass)
        .map(([cls, info]) => {
          return `<span style="color:${_classColor(cls)};font-family:'JetBrains Mono',monospace;font-size:0.7rem;">${_classShort(cls)}: z=${info.avgMeanZ.toFixed(2)}</span>`;
        }).join(' &nbsp;|&nbsp; ');

      const overlapWarn = r.overlapRatio > 0.3
        ? `<div style="color:#ffc107;font-size:0.65rem;margin-top:4px;">Sobreposição entre classes: ${(r.overlapRatio * 100).toFixed(0)}% das amostras</div>`
        : '';

      const recalBtn = r.health !== 'green'
        ? `<button id="healthCheckRecalBtn" class="btn" style="margin-top:6px;font-size:0.72rem;padding:4px 10px;background:rgba(${r.health === 'red' ? '255,82,82' : '255,193,7'},0.15);border:1px solid ${r.color};color:${r.color};border-radius:5px;cursor:pointer;">
             Recalibração Rápida
           </button>`
        : '';

      el.style.display = 'block';
      el.innerHTML = `
        <div style="padding:8px 10px;margin-top:8px;border-radius:6px;background:rgba(${r.health === 'green' ? '0,255,136' : r.health === 'yellow' ? '255,193,7' : '255,82,82'},0.06);border:1px solid ${r.color}33;font-size:0.75rem;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="color:${r.color};font-weight:600;">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${r.color};margin-right:6px;"></span>
              ${r.label}
            </span>
            <span style="color:rgba(255,255,255,0.4);font-size:0.65rem;">${r.sampleCount} amostras</span>
          </div>
          <div style="margin-top:4px;">${perClassHtml}</div>
          ${overlapWarn}
          ${recalBtn}
        </div>`;

      // Bind recal button
      const btn = document.getElementById('healthCheckRecalBtn');
      if (btn) {
        btn.addEventListener('click', () => {
          if (typeof QuickRecalibration !== 'undefined') {
            QuickRecalibration.start();
          }
        });
      }
    }
  },

  reset() {
    this._collecting = false;
    this._driftSamples = [];
    this._result = null;
    this._displayed = false;
    const el = document.getElementById('mlHealthCheck');
    if (el) {
      el.style.display = 'none';
      el.innerHTML = '';
    }
    console.log('[HealthCheck] Reset.');
  },
};

// =============================================================================
// DRIFT MONITOR (CONTINUOUS)
// - Model drift: bestMeanZ from GaussianNB feature z-scores
// - Mechanical drift: accel tilt (deg) + gyro bias (dps) vs per-class axis baselines
// =============================================================================

const DriftMonitor = {
  SAMPLE_MS: 1000,          // update UI/chart at ~1Hz (cheap + readable)
  MAX_POINTS: 600,          // 10 minutes of history at 1Hz
  ALERT_PERSIST_MS: 10000,  // must be red for >= 10s to alert
  ALERT_COOLDOWN_MS: 300000, // 5min cooldown between alerts of same kind

  _lastSampleAt: 0,
  _chart: null,
  _els: null,
  _series: { z: [], tilt: [], bias: [] },

  _modelAlert: { since: 0, lastAt: 0 },
  _mechAlert: { since: 0, lastAt: 0 },

  init() {
    this._els = {
      modelKv: document.getElementById('mlDriftModelKv'),
      mechKv: document.getElementById('mlDriftMechKv'),
      rec: document.getElementById('mlDriftRecommendation'),
      canvas: document.getElementById('mlDriftChart'),
    };

    if (this._els.canvas && typeof Chart !== 'undefined') {
      const ctx = this._els.canvas.getContext('2d');
      this._chart = new Chart(ctx, {
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Model z',
              data: [],
              borderColor: '#00d9ff',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.2,
              yAxisID: 'y',
            },
            {
              label: 'Tilt (deg)',
              data: [],
              borderColor: '#ffc107',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.2,
              yAxisID: 'y2',
            },
            {
              label: 'Gyro bias (dps)',
              data: [],
              borderColor: '#ff5252',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.2,
              yAxisID: 'y2',
            },
          ],
        },
        options: {
          animation: false,
          parsing: false,
          normalized: true,
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => {
                  if (!items || !items.length) return '';
                  return formatDateTimeLabel(items[0].parsed.x);
                },
                label: (ctx) => {
                  const y = Number.isFinite(ctx.parsed.y) ? ctx.parsed.y.toFixed(2) : '--';
                  return `${ctx.dataset.label}: ${y}`;
                },
              },
            },
          },
          scales: {
            x: { type: 'linear', display: false },
            y: {
              position: 'left',
              min: 0,
              suggestedMax: 4,
              ticks: { color: 'rgba(255,255,255,0.35)', font: { size: 10 } },
              grid: { color: 'rgba(255,255,255,0.06)' },
            },
            y2: {
              position: 'right',
              min: 0,
              suggestedMax: 20,
              ticks: { color: 'rgba(255,255,255,0.35)', font: { size: 10 } },
              grid: { drawOnChartArea: false },
            },
          },
        },
      });
    }

    this.reset();
  },

  reset() {
    this._lastSampleAt = 0;
    this._series = { z: [], tilt: [], bias: [] };
    this._modelAlert = { since: 0, lastAt: 0 };
    this._mechAlert = { since: 0, lastAt: 0 };

    if (this._els?.modelKv) this._els.modelKv.textContent = '--';
    if (this._els?.mechKv) this._els.mechKv.textContent = '--';
    if (this._els?.rec) this._els.rec.textContent = '';

    if (this._chart) {
      this._chart.data.datasets[0].data = [];
      this._chart.data.datasets[1].data = [];
      this._chart.data.datasets[2].data = [];
      this._chart.update('none');
    }
  },

  onPrediction(prediction) {
    if (!prediction || prediction.status !== 'ok' || !prediction.features) return;
    const now = Date.now();
    if (now - this._lastSampleAt < this.SAMPLE_MS) return;
    this._lastSampleAt = now;

    const model = this._computeModelDrift(prediction);
    const mech = this._computeMechanicalDrift(prediction, model);

    if (!model && !mech) return;

    const ts = Number.isFinite(prediction.timestamp) ? prediction.timestamp : now;
    if (model && Number.isFinite(model.z)) this._append('z', { x: ts, y: model.z });
    if (mech && Number.isFinite(mech.tiltDeg)) this._append('tilt', { x: ts, y: mech.tiltDeg });
    if (mech && Number.isFinite(mech.gyroBias)) this._append('bias', { x: ts, y: mech.gyroBias });

    this._updateUI(model, mech);
    this._maybeAlert(model, mech);
    this._renderChart();
  },

  _append(key, point) {
    const arr = this._series[key];
    if (!arr) return;
    arr.push(point);
    while (arr.length > this.MAX_POINTS) arr.shift();
  },

  _sevColor(sev) {
    if (sev === 'red') return '#ff5252';
    if (sev === 'yellow') return '#ffc107';
    return '#00ff88';
  },

  _modelSeverityFromZ(z) {
    if (!Number.isFinite(z)) return null;
    if (z < 1.5) return 'green';
    if (z < 2.5) return 'yellow';
    return 'red';
  },

  _mechSeverity(tiltDeg, gyroBias) {
    if (!Number.isFinite(tiltDeg) && !Number.isFinite(gyroBias)) return null;
    const tilt = Number.isFinite(tiltDeg) ? tiltDeg : 0;
    const bias = Number.isFinite(gyroBias) ? gyroBias : 0;
    if (tilt < 3 && bias < 2) return 'green';
    if (tilt < 8 && bias < 5) return 'yellow';
    return 'red';
  },

  _computeModelDrift(prediction) {
    const drift = window.fanClassifier?.computeDrift?.(prediction.features) || null;
    const z = drift?.bestMeanZ;
    if (!Number.isFinite(z)) return null;
    return {
      z,
      bestClass: drift?.bestClass || null,
      worstOverlap: !!drift?.worstOverlap,
      sev: this._modelSeverityFromZ(z),
    };
  },

  _getRecentAxisWindow(n) {
    const nSafe = Math.max(10, Math.min(300, Math.round(n || 100)));
    const slice = cache.slice(-nSafe);
    if (!slice.length) return null;
    const ax = [];
    const ay = [];
    const az = [];
    const gx = [];
    const gy = [];
    const gz = [];
    for (const it of slice) {
      if (Number.isFinite(it.accel_x_g)) ax.push(it.accel_x_g);
      if (Number.isFinite(it.accel_y_g)) ay.push(it.accel_y_g);
      if (Number.isFinite(it.accel_z_g)) az.push(it.accel_z_g);
      if (Number.isFinite(it.gyro_x_dps)) gx.push(it.gyro_x_dps);
      if (Number.isFinite(it.gyro_y_dps)) gy.push(it.gyro_y_dps);
      if (Number.isFinite(it.gyro_z_dps)) gz.push(it.gyro_z_dps);
    }
    if (ax.length < 5 || ay.length < 5 || az.length < 5 || gx.length < 5 || gy.length < 5 || gz.length < 5) {
      return null;
    }
    return { ax, ay, az, gx, gy, gz };
  },

  _norm3(x, y, z) {
    return Math.sqrt((x * x) + (y * y) + (z * z));
  },

  _angleDeg(ax, ay, az, bx, by, bz) {
    const na = this._norm3(ax, ay, az);
    const nb = this._norm3(bx, by, bz);
    if (!(na > 0) || !(nb > 0)) return null;
    const dot = (ax * bx) + (ay * by) + (az * bz);
    const c = Math.max(-1, Math.min(1, dot / (na * nb)));
    return Math.acos(c) * 180 / Math.PI;
  },

  _computeMechanicalDrift(prediction, modelDrift) {
    const baselines = getActivePerClassBaselines();
    if (!baselines) return null;

    // Use confirmed state when available; otherwise fallback to the model drift best class.
    const confirmed = prediction?.confirmedState;
    const confStr = confirmed ? String(confirmed).toUpperCase() : null;
    const cls = (confStr && _getModelLabels().includes(confStr))
      ? confStr
      : (modelDrift?.bestClass && baselines[modelDrift.bestClass] ? String(modelDrift.bestClass) : null);
    if (!cls || !baselines[cls]) return null;

    const windowN = window.ClassifierConfig?.WINDOW_SIZE || 100;
    const win = this._getRecentAxisWindow(windowN);
    if (!win) return null;

    // Robust center estimate (median) because vibration can skew the mean.
    const ax = quantileOf(win.ax, 0.5);
    const ay = quantileOf(win.ay, 0.5);
    const az = quantileOf(win.az, 0.5);
    const gx = quantileOf(win.gx, 0.5);
    const gy = quantileOf(win.gy, 0.5);
    const gz = quantileOf(win.gz, 0.5);
    if (![ax, ay, az, gx, gy, gz].every(v => Number.isFinite(v))) return null;

    const ref = baselines[cls];
    const axRef = ref.accel_x_g?.mean;
    const ayRef = ref.accel_y_g?.mean;
    const azRef = ref.accel_z_g?.mean;
    const gxRef = ref.gyro_x_dps?.mean;
    const gyRef = ref.gyro_y_dps?.mean;
    const gzRef = ref.gyro_z_dps?.mean;
    if (![axRef, ayRef, azRef, gxRef, gyRef, gzRef].every(v => Number.isFinite(v))) return null;

    const tiltDeg = this._angleDeg(ax, ay, az, axRef, ayRef, azRef);
    const gyroBias = this._norm3(gx - gxRef, gy - gyRef, gz - gzRef);
    const sev = this._mechSeverity(tiltDeg, gyroBias);

    return {
      tiltDeg,
      gyroBias,
      cls,
      sev,
      source: refBaselinesSource || 'training',
    };
  },

  _updateUI(model, mech) {
    const modelEl = this._els?.modelKv;
    const mechEl = this._els?.mechKv;
    const recEl = this._els?.rec;

    if (modelEl) {
      if (!model) {
        modelEl.textContent = '--';
      } else {
        const c = this._sevColor(model.sev);
        const cls = model.bestClass ? ` best=${model.bestClass}` : '';
        const overlap = model.worstOverlap ? ' overlap' : '';
        modelEl.innerHTML = `<span style="color:${c};font-weight:800;">${model.sev?.toUpperCase?.() || '--'}</span> z=${model.z.toFixed(2)}${cls}${overlap}`;
      }
    }

    if (mechEl) {
      if (!mech) {
        mechEl.textContent = '--';
      } else {
        const c = this._sevColor(mech.sev);
        const tiltTxt = Number.isFinite(mech.tiltDeg) ? mech.tiltDeg.toFixed(1) + 'deg' : '--';
        const biasTxt = Number.isFinite(mech.gyroBias) ? mech.gyroBias.toFixed(2) + 'dps' : '--';
        const src = mech.source === 'adapted' ? 'adapt' : 'train';
        mechEl.innerHTML = `<span style="color:${c};font-weight:800;">${mech.sev?.toUpperCase?.() || '--'}</span> tilt=${tiltTxt} bias=${biasTxt} (${mech.cls}, ${src})`;
      }
    }

    if (recEl) {
      const modelSev = model?.sev || null;
      const mechSev = mech?.sev || null;
      let html = '';
      let color = 'rgba(255,255,255,0.55)';

      if (mechSev === 'red') {
        color = '#ffc107';
        html = `Drift mecanico alto (provavel mudanca de fixacao/orientacao). Verifique o sensor antes de recalibrar.`;
      } else if (modelSev === 'red') {
        color = '#ff5252';
        html = `Drift severo no modelo (features fora do treino). Recalibracao rapida sugerida. <button id="mlDriftRecalBtn" class="btn" style="margin-left:8px;font-size:0.72rem;padding:3px 10px;background:rgba(255,82,82,0.15);border:1px solid #ff5252;color:#ff5252;border-radius:5px;cursor:pointer;">Recalibrar</button>`;
      } else if (modelSev === 'yellow' || mechSev === 'yellow') {
        color = '#ffc107';
        html = `Drift moderado. Se persistir, rode Soak/Transicao e considere Recalibracao rapida.`;
      } else if (modelSev === 'green' || mechSev === 'green') {
        color = 'rgba(0,255,136,0.75)';
        html = `Drift OK.`;
      } else {
        html = '';
      }

      recEl.innerHTML = html ? `<span style="color:${color};font-weight:600;">${html}</span>` : '';

      const btn = document.getElementById('mlDriftRecalBtn');
      if (btn) {
        btn.onclick = () => {
          if (typeof QuickRecalibration !== 'undefined') {
            QuickRecalibration.start();
          }
        };
      }
    }
  },

  _maybeAlert(model, mech) {
    const now = Date.now();

    // Model alerts
    if (model?.sev === 'red') {
      if (!this._modelAlert.since) this._modelAlert.since = now;
      const persisted = (now - this._modelAlert.since) >= this.ALERT_PERSIST_MS;
      const cooled = (now - this._modelAlert.lastAt) >= this.ALERT_COOLDOWN_MS;
      if (persisted && cooled) {
        this._modelAlert.lastAt = now;
        alerts.unshift({
          severity: 'HIGH',
          source: 'DRIFT',
          message: `Drift severo no modelo (z=${model.z.toFixed(2)}). Sugerido: Recalibracao rapida.`,
          time: new Date(now),
        });
        if (alerts.length > 10) alerts.pop();
        renderAlerts();
      }
    } else {
      this._modelAlert.since = 0;
    }

    // Mechanical alerts
    if (mech?.sev === 'red') {
      if (!this._mechAlert.since) this._mechAlert.since = now;
      const persisted = (now - this._mechAlert.since) >= this.ALERT_PERSIST_MS;
      const cooled = (now - this._mechAlert.lastAt) >= this.ALERT_COOLDOWN_MS;
      if (persisted && cooled) {
        this._mechAlert.lastAt = now;
        const tiltTxt = Number.isFinite(mech.tiltDeg) ? mech.tiltDeg.toFixed(1) : '--';
        const biasTxt = Number.isFinite(mech.gyroBias) ? mech.gyroBias.toFixed(2) : '--';
        alerts.unshift({
          severity: 'HIGH',
          source: 'MECH',
          message: `Drift mecanico alto (tilt=${tiltTxt}deg, bias=${biasTxt}dps). Verifique fixacao/orientacao.`,
          time: new Date(now),
        });
        if (alerts.length > 10) alerts.pop();
        renderAlerts();
      }
    } else {
      this._mechAlert.since = 0;
    }
  },

  _renderChart() {
    if (!this._chart) return;
    this._chart.data.datasets[0].data = this._series.z;
    this._chart.data.datasets[1].data = this._series.tilt;
    this._chart.data.datasets[2].data = this._series.bias;
    this._chart.update('none');
  },
};

// =============================================================================
// QUICK RECALIBRATION
// Fast 3-class recalibration (~60-90s total) for drift recovery.
// =============================================================================

const QuickRecalibration = {
  SEQUENCE: null, // initialized at start()
  HOLD_S: 20,
  SETTLE_S: 3,
  MAX_WAIT_S: 10,
  TICK_MS: 200,

  _active: false,
  _stepIdx: 0,
  _phase: 'idle',     // idle | waiting | settling | holding | done
  _phaseStart: 0,
  _holdSamples: [],    // collected features during hold
  _axisSamples: [],    // raw axis data during hold
  _segments: [],       // completed segments
  _tickTimer: null,
  _sampleTimer: null,

  start() {
    if (this._active) return;
    this.SEQUENCE = _getModelLabels();
    this._active = true;
    this._stepIdx = 0;
    this._segments = [];

    // Reset classifier buffer for fresh data
    if (window.fanClassifier) {
      window.fanClassifier.reset();
    }

    this._showUI();
    this._startStep();
    console.log('[QuickRecal] Started.');
  },

  stop() {
    this._active = false;
    this._phase = 'idle';
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    if (this._sampleTimer) { clearInterval(this._sampleTimer); this._sampleTimer = null; }
    this._updateStepUI('Recalibração cancelada.', 'rgba(255,255,255,0.5)');
    console.log('[QuickRecal] Stopped.');
  },

  _startStep() {
    const target = this.SEQUENCE[this._stepIdx];
    this._phase = 'waiting';
    this._phaseStart = Date.now();
    this._holdSamples = [];
    this._axisSamples = [];
    this._updateStepUI(`Mude o ventilador para <strong style="color:${this._classColor(target)};">${_classShort(target)}</strong> e aguarde...`, '#00d9ff');

    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = setInterval(() => this._tick(), this.TICK_MS);
  },

  _tick() {
    if (!this._active) return;
    const target = this.SEQUENCE[this._stepIdx];
    const elapsed = (Date.now() - this._phaseStart) / 1000;
    const confirmedState = window.fanClassifier?.confirmedState;

    if (this._phase === 'waiting') {
      if (confirmedState === target || elapsed >= this.MAX_WAIT_S) {
        if (confirmedState !== target) {
          console.log(`[QuickRecal] ${target}: wait timeout, proceeding anyway.`);
        }
        this._phase = 'settling';
        this._phaseStart = Date.now();
        this._updateStepUI(`<strong style="color:${this._classColor(target)};">${_classShort(target)}</strong>: estabilizando...`, '#ffc107');
        return;
      }
      const remaining = Math.max(0, this.MAX_WAIT_S - elapsed);
      this._updateTimer(`Aguardando ${target}... ${remaining.toFixed(0)}s`);
      return;
    }

    if (this._phase === 'settling') {
      if (elapsed >= this.SETTLE_S) {
        this._phase = 'holding';
        this._phaseStart = Date.now();
        this._holdSamples = [];
        this._axisSamples = [];
        this._updateStepUI(`<strong style="color:${this._classColor(target)};">${_classShort(target)}</strong>: coletando dados...`, '#00ff88');
        // Sample features at ~1Hz during hold
        if (this._sampleTimer) clearInterval(this._sampleTimer);
        this._sampleTimer = setInterval(() => this._collectSample(), 1000);
        return;
      }
      const remaining = Math.max(0, this.SETTLE_S - elapsed);
      this._updateTimer(`Settle ${remaining.toFixed(0)}s`);
      return;
    }

    if (this._phase === 'holding') {
      if (elapsed >= this.HOLD_S) {
        if (this._sampleTimer) { clearInterval(this._sampleTimer); this._sampleTimer = null; }
        this._finishStep();
        return;
      }
      const remaining = Math.max(0, this.HOLD_S - elapsed);
      this._updateTimer(`Coletando: ${remaining.toFixed(0)}s restantes (${this._holdSamples.length} amostras)`);
      return;
    }
  },

  _collectSample() {
    if (!this._active || this._phase !== 'holding') return;

    const pred = window.fanClassifier?.lastPrediction;
    if (pred && pred.features) {
      this._holdSamples.push({ ...pred.features });
    }

    // Collect raw axis data from lastPayload
    if (typeof lastPayload !== 'undefined' && lastPayload) {
      this._axisSamples.push({
        accel_x_g: lastPayload.accel_x_g ?? lastPayload.AX ?? 0,
        accel_y_g: lastPayload.accel_y_g ?? lastPayload.AY ?? 0,
        accel_z_g: lastPayload.accel_z_g ?? lastPayload.AZ ?? 0,
        gyro_x_dps: lastPayload.gyro_x_dps ?? lastPayload.GX ?? 0,
        gyro_y_dps: lastPayload.gyro_y_dps ?? lastPayload.GY ?? 0,
        gyro_z_dps: lastPayload.gyro_z_dps ?? lastPayload.GZ ?? 0,
      });
    }
  },

  _finishStep() {
    const target = this.SEQUENCE[this._stepIdx];
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }

    // Compute feature_stats from collected samples
    const featureStats = {};
    if (this._holdSamples.length >= 2) {
      const featureNames = Object.keys(this._holdSamples[0]);
      for (const fname of featureNames) {
        const vals = this._holdSamples.map(s => s[fname]).filter(v => Number.isFinite(v));
        const summary = summarizeNumeric(vals);
        if (summary) featureStats[fname] = summary;
      }
    }

    // Compute axis_stats from collected raw data
    const axisStats = {};
    if (this._axisSamples.length >= 2) {
      for (const axisKey of ['accel_x_g', 'accel_y_g', 'accel_z_g', 'gyro_x_dps', 'gyro_y_dps', 'gyro_z_dps']) {
        const vals = this._axisSamples.map(s => s[axisKey]).filter(v => Number.isFinite(v));
        const summary = summarizeNumeric(vals);
        if (summary) axisStats[axisKey] = summary;
      }
    }

    const segment = {
      target,
      feature_stats: featureStats,
      feature_samples_n: this._holdSamples.length,
      axis_stats: axisStats,
      hold_s: this.HOLD_S,
      target_ratio: 1.0,   // Quick recal assumes user followed instructions
      confidence: { mean: 0.8 },
      flips_per_min: 0,
      time_to_target_s: 0,
    };

    this._segments.push(segment);
    console.log(`[QuickRecal] Step ${this._stepIdx + 1}/${this.SEQUENCE.length} done: ${target} (${this._holdSamples.length} samples)`);

    this._stepIdx++;
    if (this._stepIdx < this.SEQUENCE.length) {
      this._startStep();
    } else {
      this._finish();
    }
  },

  _finish() {
    this._active = false;
    this._phase = 'done';

    const sessionStats = OnlineLearning.extractSessionStats(this._segments);
    if (!sessionStats) {
      this._updateStepUI('Falha: dados insuficientes para recalibração.', '#ff5252');
      return;
    }

    // Compute suggested lambda
    const suggestion = window.fanClassifier?.computeSuggestedLambda(sessionStats);
    const suggestedLambda = suggestion ? suggestion.lambda : 0.85;
    const lambdaExpl = suggestion ? suggestion.explanation : 'Padrão';

    // Preview delta
    const previewResult = OnlineLearning.preview(this._segments, suggestedLambda);
    const deltaHtml = previewResult ? OnlineLearning._buildDeltaHtml(previewResult.delta) : '';

    const section = document.getElementById('quickRecalSection');
    if (!section) return;

    section.innerHTML = `
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;">
        <span style="color:#00ff88;font-weight:600;">Recalibração Concluída</span>
      </div>
      <div style="font-size:0.75rem;color:rgba(255,255,255,0.6);margin-bottom:8px;">
        ${this.SEQUENCE.length} classes coletadas em ~${((this.HOLD_S + this.SETTLE_S + this.MAX_WAIT_S) * this.SEQUENCE.length / 60).toFixed(1)} min
      </div>

      <div style="padding:8px 10px;border-radius:6px;background:rgba(0,217,255,0.06);border:1px solid rgba(0,217,255,0.15);margin-bottom:10px;">
        <div style="font-size:0.75rem;color:#00d9ff;font-weight:600;margin-bottom:4px;">
          Lambda sugerido: ${suggestedLambda.toFixed(2)}
          <span style="color:rgba(255,255,255,0.5);font-weight:400;margin-left:6px;">(${lambdaExpl}${suggestion ? ` | div: ${suggestion.divergence.toFixed(2)}` : ''})</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <label style="color:rgba(255,255,255,0.6);font-size:0.72rem;white-space:nowrap;">
            Lambda: <span id="qrLambdaVal" style="color:#00d9ff;font-family:'JetBrains Mono',monospace;">${suggestedLambda.toFixed(2)}</span>
          </label>
          <input type="range" id="qrLambdaSlider" min="0.50" max="1.00" step="0.01" value="${suggestedLambda.toFixed(2)}"
            style="flex:1;accent-color:#00d9ff;cursor:pointer;">
        </div>
      </div>

      ${deltaHtml ? `
        <details style="margin-bottom:10px;">
          <summary style="cursor:pointer;font-size:0.72rem;color:rgba(255,255,255,0.5);">Preview das mudanças</summary>
          <div style="margin-top:6px;">${deltaHtml}</div>
        </details>
      ` : ''}

      <div style="display:flex;gap:8px;">
        <button id="qrApplyBtn" class="btn" style="background:rgba(0,255,136,0.15);border:1px solid rgba(0,255,136,0.4);color:#00ff88;font-size:0.8rem;font-weight:700;padding:5px 14px;border-radius:6px;cursor:pointer;">
          Aplicar Recalibração
        </button>
        <button id="qrDismissBtn" class="btn" style="background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.5);font-size:0.8rem;padding:5px 14px;border-radius:6px;cursor:pointer;">
          Descartar
        </button>
      </div>
      <div id="qrResult" style="display:none;margin-top:8px;"></div>
    `;

    // Lambda slider
    const slider = document.getElementById('qrLambdaSlider');
    const valEl = document.getElementById('qrLambdaVal');
    if (slider && valEl) {
      slider.addEventListener('input', () => {
        valEl.textContent = parseFloat(slider.value).toFixed(2);
      });
    }

    // Apply button
    const applyBtn = document.getElementById('qrApplyBtn');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        const lambda = parseFloat(slider?.value || suggestedLambda);
        const tag = 'quick_recal';
        const delta = OnlineLearning.absorb(this._segments, lambda, tag);
        const resultEl = document.getElementById('qrResult');
        if (delta) {
          resultEl.innerHTML = `
            <div style="color:#00ff88;font-size:0.8rem;font-weight:600;">
              Modelo recalibrado com sucesso! (λ=${lambda.toFixed(2)})
            </div>`;
          applyBtn.disabled = true;
          applyBtn.style.opacity = '0.4';
          // Reset health check to re-evaluate
          ModelHealthCheck.reset();
          DriftMonitor.reset();
        } else {
          resultEl.innerHTML = '<div style="color:#ff5252;font-size:0.8rem;">Falha na recalibração.</div>';
        }
        resultEl.style.display = 'block';
      });
    }

    // Dismiss button
    const dismissBtn = document.getElementById('qrDismissBtn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        section.style.display = 'none';
      });
    }
  },

  _showUI() {
    const section = document.getElementById('quickRecalSection');
    if (!section) return;
    section.style.display = 'block';
    section.innerHTML = `
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;">
        <span>Recalibração Rápida</span>
        <span style="font-size:0.7rem;color:#00d9ff;">${this.SEQUENCE.length} classes × ${this.HOLD_S}s</span>
      </div>
      <div id="qrStepInstruction" style="text-align:center;padding:12px 10px;">
        <div id="qrStepText" style="font-size:1rem;font-weight:600;color:rgba(255,255,255,0.7);">Iniciando...</div>
        <div id="qrStepTimer" style="font-size:1.8rem;font-weight:700;color:#00d9ff;margin-top:6px;font-family:'JetBrains Mono',monospace;">--</div>
      </div>
      <div style="display:flex;gap:4px;margin:8px 0;" id="qrStepBar">
        ${this.SEQUENCE.map((cls, i) => `
          <div style="flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);" id="qrStep${i}"></div>
        `).join('')}
      </div>
      <div style="text-align:center;">
        <button id="qrStopBtn" class="btn" style="background:rgba(255,82,82,0.15);border:1px solid rgba(255,82,82,0.4);color:#ff5252;font-size:0.75rem;padding:4px 12px;border-radius:5px;cursor:pointer;">Cancelar</button>
      </div>
    `;

    const stopBtn = document.getElementById('qrStopBtn');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => this.stop());
    }
  },

  _updateStepUI(html, color) {
    const el = document.getElementById('qrStepText');
    if (el) el.innerHTML = html;

    // Update step bar
    for (let i = 0; i < this.SEQUENCE.length; i++) {
      const bar = document.getElementById(`qrStep${i}`);
      if (!bar) continue;
      if (i < this._stepIdx) {
        bar.style.background = '#00ff88';
      } else if (i === this._stepIdx && this._active) {
        bar.style.background = color || '#00d9ff';
      }
    }
  },

  _updateTimer(text) {
    const el = document.getElementById('qrStepTimer');
    if (el) el.textContent = text;
  },

  _classColor(cls) {
    return _classColor(cls);
  },
};

// =============================================================================
// AUTO-TUNE ML PARAMETERS
// =============================================================================

const AUTO_TUNE_STORAGE_KEY = 'iot_fan_tuned_params';

function showAutoTuneUI(segments) {
  const section = document.getElementById('autoTuneSection');
  if (!section) return;

  const cfg = window.ClassifierConfig;
  if (!cfg || !cfg.computeAutoTune) return;

  const result = cfg.computeAutoTune(segments);
  const mode = result?.mode || 'diagnostic';
  section.style.display = 'block';

  // --- Helper: build diagnostic per-class analysis HTML ---
  const buildDiagnosticHtml = (diag) => {
    if (!diag) return '';
    const entries = Object.entries(diag.perClass || {});
    if (!entries.length && !diag.message) return '';

    let html = '';
    if (diag.message) {
      html += `<div style="color:#ffc107;font-size:0.75rem;margin-bottom:6px;">${diag.message}</div>`;
    }
    if (entries.length) {
      html += `<div style="font-size:0.7rem;color:rgba(255,255,255,0.5);margin-bottom:4px;">Análise por classe:</div>`;
      for (const [label, info] of entries) {
        const probIcon = info.problematic ? '<span style="color:#ff5252;margin-left:4px;">PROBLEM</span>' : '';
        html += `<div style="font-size:0.7rem;color:rgba(255,255,255,0.6);margin-left:8px;">
          <span style="color:${_classColor(label)};font-weight:600;">${_classShort(label)}</span>:
          ${info.segments} seg, ratio=${(info.avgTargetRatio * 100).toFixed(0)}%, conf=${(info.avgConfidence * 100).toFixed(0)}%${probIcon}
        </div>`;
      }
    }
    return html;
  };

  // --- DIAGNOSTIC mode ---
  if (mode === 'diagnostic') {
    section.innerHTML = `
      <div style="margin-top:12px;padding:10px 14px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,193,7,0.15);">
        <div style="font-weight:600;font-size:0.85rem;color:rgba(255,255,255,0.7);margin-bottom:6px;">
          Auto-Ajuste de Parâmetros
          <span style="font-size:0.7rem;color:#ffc107;margin-left:6px;">Diagnóstico</span>
        </div>
        ${buildDiagnosticHtml(result.diagnostic)}
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button id="autoTuneDismissBtn" style="padding:5px 14px;border:none;border-radius:5px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.5);font-size:0.78rem;cursor:pointer;">
            Fechar
          </button>
        </div>
      </div>`;
    document.getElementById('autoTuneDismissBtn')?.addEventListener('click', () => {
      section.style.display = 'none';
    });
    return;
  }

  const rec = result.recommendations;
  const lat = result.latency;
  const q = result.quality;

  // --- PARTIAL mode ---
  if (mode === 'partial') {
    const partialLabels = {
      SMOOTHING_ALPHA: 'Suavização (α)',
      HYSTERESIS_COUNT: 'Histerese Geral',
    };
    const fmtVal = (key, v) => key === 'SMOOTHING_ALPHA' ? parseFloat(v).toFixed(2) : v;

    let tableRows = '';
    for (const [key, label] of Object.entries(partialLabels)) {
      const cur = cfg[key];
      const tuned = rec[key];
      const changed = cur !== tuned;
      const color = changed ? '#00ff88' : 'rgba(255,255,255,0.5)';
      const arrow = changed ? '→' : '=';
      tableRows += `<tr>
        <td style="text-align:left;font-size:0.78rem;color:rgba(255,255,255,0.7);padding:3px 6px;">${label}</td>
        <td style="text-align:center;font-size:0.78rem;color:rgba(255,255,255,0.5);padding:3px 6px;">${fmtVal(key, cur)}</td>
        <td style="text-align:center;font-size:0.78rem;color:rgba(255,255,255,0.3);padding:3px 2px;">${arrow}</td>
        <td style="text-align:center;font-size:0.78rem;color:${color};font-weight:${changed ? '700' : '400'};padding:3px 6px;">${fmtVal(key, tuned)}</td>
      </tr>`;
    }

    const improvStr = lat.improvement_pct > 0 ? ` (-${lat.improvement_pct}%)` : '';

    section.innerHTML = `
      <div style="margin-top:12px;padding:12px 14px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,193,7,0.2);">
        <div style="font-weight:600;font-size:0.85rem;color:rgba(255,255,255,0.7);margin-bottom:6px;">
          Auto-Ajuste de Parâmetros
          <span style="font-size:0.7rem;color:#ffc107;margin-left:6px;">Parcial</span>
        </div>
        <div style="padding:6px 10px;margin-bottom:8px;border-radius:6px;background:rgba(255,193,7,0.06);border:1px solid rgba(255,193,7,0.15);font-size:0.72rem;color:#ffc107;">
          Modo parcial: apenas 2 parâmetros ajustáveis (gates insuficientes para ajuste completo).
        </div>
        <table style="border-collapse:collapse;width:100%;margin-bottom:8px;">
          <thead><tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
            <th style="text-align:left;font-size:0.7rem;color:rgba(255,255,255,0.4);padding:2px 6px;">Parâmetro</th>
            <th style="text-align:center;font-size:0.7rem;color:rgba(255,255,255,0.4);padding:2px 6px;">Atual</th>
            <th style="padding:2px 2px;"></th>
            <th style="text-align:center;font-size:0.7rem;color:rgba(255,255,255,0.4);padding:2px 6px;">Recomendado</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
        <div style="font-size:0.75rem;color:rgba(255,255,255,0.5);margin-bottom:8px;">
          Latência: <span style="color:rgba(255,255,255,0.4);">${lat.current_general_ms}ms</span>
          → <span style="color:#00ff88;font-weight:700;">${lat.tuned_general_ms}ms</span>
          <span style="color:rgba(0,255,136,0.6);">${improvStr}</span>
        </div>
        ${buildDiagnosticHtml(result.diagnostic)}
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button id="autoTuneApplyBtn" style="padding:5px 14px;border:none;border-radius:5px;background:#00cc66;color:#000;font-weight:700;font-size:0.78rem;cursor:pointer;">
            Aplicar (2 params)
          </button>
          <button id="autoTuneDismissBtn" style="padding:5px 14px;border:none;border-radius:5px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.5);font-size:0.78rem;cursor:pointer;">
            Ignorar
          </button>
        </div>
      </div>`;

    document.getElementById('autoTuneApplyBtn')?.addEventListener('click', () => {
      applyAutoTuneRecommendations(rec);
      section.innerHTML = `
        <div style="margin-top:12px;padding:8px 14px;background:rgba(0,255,136,0.06);border-radius:8px;border:1px solid rgba(0,255,136,0.15);font-size:0.78rem;color:#00ff88;">
          Parâmetros parciais aplicados com sucesso (SMOOTHING_ALPHA + HYSTERESIS_COUNT).
        </div>`;
    });
    document.getElementById('autoTuneDismissBtn')?.addEventListener('click', () => {
      section.style.display = 'none';
    });
    return;
  }

  // --- FULL mode (original behavior) ---
  const paramLabels = {
    SMOOTHING_ALPHA: 'Suavização (α)',
    HYSTERESIS_COUNT: 'Histerese Geral',
    ADJACENT_TRANSITION_CONFIDENCE_GATE: 'Gate Adj.',
    ADJACENT_TRANSITION_HYSTERESIS_COUNT: 'Histerese Adj.',
    CHANGE_DETECT_RATIO: 'Detecção Mudança',
  };

  const fmtVal = (key, v) => {
    if (key === 'SMOOTHING_ALPHA' || key === 'ADJACENT_TRANSITION_CONFIDENCE_GATE' || key === 'CHANGE_DETECT_RATIO') {
      return parseFloat(v).toFixed(2);
    }
    return v;
  };

  let tableRows = '';
  for (const [key, label] of Object.entries(paramLabels)) {
    const cur = cfg[key];
    const tuned = rec[key];
    const changed = cur !== tuned;
    const color = changed ? '#00ff88' : 'rgba(255,255,255,0.5)';
    const arrow = changed ? '→' : '=';
    tableRows += `
      <tr>
        <td style="text-align:left;font-size:0.78rem;color:rgba(255,255,255,0.7);padding:3px 6px;">${label}</td>
        <td style="text-align:center;font-size:0.78rem;color:rgba(255,255,255,0.5);padding:3px 6px;">${fmtVal(key, cur)}</td>
        <td style="text-align:center;font-size:0.78rem;color:rgba(255,255,255,0.3);padding:3px 2px;">${arrow}</td>
        <td style="text-align:center;font-size:0.78rem;color:${color};font-weight:${changed ? '700' : '400'};padding:3px 6px;">${fmtVal(key, tuned)}</td>
      </tr>`;
  }

  const improvStr = lat.improvement_pct > 0 ? ` (-${lat.improvement_pct}%)` : '';
  const improvAdjStr = (lat.improvement_adj_pct || 0) > 0 ? ` (-${lat.improvement_adj_pct}%)` : '';

  section.innerHTML = `
    <div style="margin-top:12px;padding:12px 14px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(0,255,136,0.15);">
      <div style="font-weight:600;font-size:0.85rem;color:rgba(255,255,255,0.7);margin-bottom:8px;">
        Auto-Ajuste de Parâmetros
        <span style="font-size:0.7rem;color:rgba(0,255,136,0.6);margin-left:6px;">Score: ${(q.score * 100).toFixed(0)}%</span>
      </div>

      <table style="border-collapse:collapse;width:100%;margin-bottom:8px;">
        <thead>
          <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
            <th style="text-align:left;font-size:0.7rem;color:rgba(255,255,255,0.4);padding:2px 6px;">Parâmetro</th>
            <th style="text-align:center;font-size:0.7rem;color:rgba(255,255,255,0.4);padding:2px 6px;">Atual</th>
            <th style="padding:2px 2px;"></th>
            <th style="text-align:center;font-size:0.7rem;color:rgba(255,255,255,0.4);padding:2px 6px;">Recomendado</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>

      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px;font-size:0.75rem;">
        <div style="color:rgba(255,255,255,0.5);">
          Latência Geral: <span style="color:rgba(255,255,255,0.4);">${lat.current_general_ms}ms</span>
          → <span style="color:#00ff88;font-weight:700;">${lat.tuned_general_ms}ms</span>
          <span style="color:rgba(0,255,136,0.6);">${improvStr}</span>
        </div>
        <div style="color:rgba(255,255,255,0.5);">
          Latência Adj.: <span style="color:rgba(255,255,255,0.4);">${lat.current_adj_ms}ms</span>
          → <span style="color:#00ff88;font-weight:700;">${lat.tuned_adj_ms}ms</span>
          <span style="color:rgba(0,255,136,0.6);">${improvAdjStr}</span>
        </div>
      </div>

      <div style="font-size:0.7rem;color:rgba(255,255,255,0.35);margin-bottom:10px;">
        Conf média: ${meanConf_fmt(q.meanConf)} | Max flips/min: ${q.maxFlips.toFixed(1)} | Mediana TTT: ${q.medianTTT.toFixed(1)}s | Segmentos: ${q.segmentCount} (${q.classCount} classes)
      </div>

      <div style="display:flex;gap:8px;">
        <button id="autoTuneApplyBtn" style="padding:5px 14px;border:none;border-radius:5px;background:#00cc66;color:#000;font-weight:700;font-size:0.78rem;cursor:pointer;">
          Aplicar Recomendações
        </button>
        <button id="autoTuneDismissBtn" style="padding:5px 14px;border:none;border-radius:5px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.5);font-size:0.78rem;cursor:pointer;">
          Ignorar
        </button>
      </div>
    </div>`;

  document.getElementById('autoTuneApplyBtn')?.addEventListener('click', () => {
    applyAutoTuneRecommendations(rec);
    section.innerHTML = `
      <div style="margin-top:12px;padding:8px 14px;background:rgba(0,255,136,0.06);border-radius:8px;border:1px solid rgba(0,255,136,0.15);font-size:0.78rem;color:#00ff88;">
        Parâmetros auto-ajustados aplicados com sucesso.
      </div>`;
  });

  document.getElementById('autoTuneDismissBtn')?.addEventListener('click', () => {
    section.style.display = 'none';
  });
}

function meanConf_fmt(v) {
  return v != null ? (v * 100).toFixed(1) + '%' : '--';
}

function applyAutoTuneRecommendations(rec) {
  const cfg = window.ClassifierConfig;
  if (!cfg || !rec) return;

  for (const [key, value] of Object.entries(rec)) {
    cfg[key] = value;
  }

  // Sync sliders visually
  ML_PARAM_SLIDERS.forEach(({ id, key, valId, fmt }) => {
    if (rec[key] == null) return;
    const slider = document.getElementById(id);
    const valEl = document.getElementById(valId);
    if (slider) slider.value = cfg[key];
    if (valEl) valEl.textContent = fmt(cfg[key]);
  });

  // Persist to localStorage
  try {
    localStorage.setItem(AUTO_TUNE_STORAGE_KEY, JSON.stringify({
      params: rec,
      applied_at: new Date().toISOString(),
    }));
  } catch (e) { /* ignore */ }

  updateMLDecisionMeta();
  _updateAutoTuneBadge(true);
}

function _updateAutoTuneBadge(active) {
  const existing = document.getElementById('mlAutoTuneBadge');
  if (active) {
    if (!existing) {
      const summary = document.querySelector('#mlParamsDetails > summary');
      if (summary) {
        const badge = document.createElement('span');
        badge.id = 'mlAutoTuneBadge';
        badge.textContent = '(Auto-Tune)';
        badge.style.cssText = 'color:#ffc832;font-size:0.7rem;font-weight:600;margin-left:6px;';
        summary.appendChild(badge);
      }
    }
  } else {
    if (existing) existing.remove();
  }
}

// =============================================================================
// TRANSITION LOG SELECTOR
// =============================================================================

function parseTransitionLogSampleRate(fileName) {
  if (!fileName) return null;
  const match = fileName.match(/_f_(\d+)\.json$/i);
  if (!match) return null;
  const rate = parseInt(match[1], 10);
  return Number.isFinite(rate) ? rate : null;
}

async function loadTransitionLogList() {
  const select = document.getElementById('ttLogSelect');
  if (!select) return;
  const current = select.value;
  try {
    const res = await fetch('../api/log_transition?action=list', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const list = await res.json();
    select.innerHTML = '';
    if (!Array.isArray(list) || list.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Nenhum log encontrado';
      select.appendChild(opt);
      renderTransitionLogSummary(null, null);
      return;
    }
    list.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.file;
      const freq = parseTransitionLogSampleRate(item.file);
      const freqLabel = freq ? ` | f=${freq} Hz` : '';
      const label = item.modified
        ? `${item.modified} | ${item.file} (${item.entries})${freqLabel}`
        : `${item.file} (${item.entries})${freqLabel}`;
      opt.textContent = label;
      select.appendChild(opt);
    });
    const target = current && list.some(l => l.file === current) ? current : list[0].file;
    select.value = target;
    if (target) loadTransitionLogFile(target);
  } catch (err) {
    console.warn('[TransitionLog] Falha ao listar logs:', err);
  }
}

async function loadTransitionLogFile(file) {
  if (!file) return;
  try {
    const res = await fetch(`../api/log_transition?file=${encodeURIComponent(file)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const entries = Array.isArray(data) ? data : [];
    const transitionTests = entries.filter(entry => entry?.type === 'transition_test');
    const stabilityTests = entries.filter(entry => entry?.type === 'stability_test');
    const transitionTest = transitionTests.length ? transitionTests[transitionTests.length - 1] : null;
    const stabilityTest = stabilityTests.length ? stabilityTests[stabilityTests.length - 1] : null;
    // Collect raw transition entries (type === 'transition' or entries without type that have from/to)
    const rawTransitions = entries.filter(entry =>
      entry?.type === 'transition' || (!entry?.type && entry?.from && entry?.to)
    );
    renderTransitionLogSummary({ transitionTest, stabilityTest, rawTransitions }, file);
  } catch (err) {
    console.warn('[TransitionLog] Falha ao carregar log:', err);
  }
}

function renderTransitionLogSummary(tests, fileName) {
  const section = document.getElementById('ttLogSummarySection');
  const content = document.getElementById('ttLogSummaryContent');
  const meta = document.getElementById('ttLogSummaryMeta');
  if (!section || !content || !meta) return;

  let transitionTest = null;
  let stabilityTest = null;
  let rawTransitions = [];
  if (tests && typeof tests === 'object' && tests.type === 'transition_test') {
    transitionTest = tests;
  } else if (tests && typeof tests === 'object' && tests.type === 'stability_test') {
    stabilityTest = tests;
  } else if (tests && typeof tests === 'object') {
    transitionTest = tests.transitionTest || null;
    stabilityTest = tests.stabilityTest || null;
    rawTransitions = Array.isArray(tests.rawTransitions) ? tests.rawTransitions : [];
  }

  if (!transitionTest && !stabilityTest && rawTransitions.length === 0) {
    meta.textContent = fileName ? `Arquivo: ${fileName}` : '';
    content.innerHTML = `<div style="font-size:0.75rem;color:rgba(255,255,255,0.45);font-style:italic;">
      Nenhum dado encontrado neste log.
    </div>`;
    section.style.display = 'block';
    return;
  }

  // If no test entries but we have raw transitions, show them directly
  if (!transitionTest && !stabilityTest && rawTransitions.length > 0) {
    meta.textContent = fileName ? `Arquivo: ${fileName} | ${rawTransitions.length} transições` : '';
    content.innerHTML = _buildRawTransitionsHtml(rawTransitions);
    section.style.display = 'block';
    return;
  }

  const metaParts = [];
  if (fileName) metaParts.push(`Arquivo: ${fileName}`);
  const cfgHz = (transitionTest?.trace?.configured_sample_rate_hz ?? stabilityTest?.trace?.configured_sample_rate_hz);
  const trainHz = (transitionTest?.trace?.training_sample_rate_hz ?? stabilityTest?.trace?.training_sample_rate_hz);
  if (cfgHz) metaParts.push(`Config: ${cfgHz} Hz`);
  if (trainHz) metaParts.push(`Treino: ${trainHz} Hz`);
  const colId = (transitionTest?.trace?.collection_id ?? stabilityTest?.trace?.collection_id);
  if (colId) metaParts.push(`Collection: ${colId}`);

  meta.textContent = metaParts.join(' | ');

  let html = '';

  if (transitionTest) {
    const baseSummary = buildTransitionSummary(transitionTest.results || [], transitionTest.test_duration_s);
    const summary = { ...baseSummary, ...(transitionTest.summary || {}) };
    if (summary.total_duration_s == null) summary.total_duration_s = transitionTest.test_duration_s ?? baseSummary.total_duration_s;
    const rendered = buildTransitionSummaryHtml(summary);
    const started = transitionTest.test_started ? new Date(transitionTest.test_started) : null;
    const ended = transitionTest.test_ended ? new Date(transitionTest.test_ended) : null;
    const dt = transitionTest.test_time ? new Date(transitionTest.test_time) : null;
    const tag = transitionTest.test_tag || transitionTest.trace?.tag;
    const notes = transitionTest.test_notes || transitionTest.trace?.notes;
    const headBits = [];
    if (started) headBits.push(`Inicio: ${started.toLocaleString('pt-BR')}`);
    else if (dt) headBits.push(`Teste: ${dt.toLocaleString('pt-BR')}`);
    if (ended) headBits.push(`Fim: ${ended.toLocaleString('pt-BR')}`);
    if (tag) headBits.push(`Tag: ${tag}`);
    if (notes) headBits.push(`Obs: ${notes}`);
    const head = headBits.length
      ? `<div style="font-size:0.7rem;color:rgba(255,255,255,0.55);margin:2px 0 8px;">${headBits.join(' | ')}</div>`
      : '';
    html += `
      <div style="margin-bottom:12px;">
        <div style="font-size:0.75rem;color:#00d9ff;font-weight:600;margin-bottom:4px;">Teste Guiado de Transicao</div>
        ${head}
        ${rendered.html}
      </div>
    `;
  }

  if (stabilityTest) {
    const started = stabilityTest.test_started ? new Date(stabilityTest.test_started) : null;
    const ended = stabilityTest.test_ended ? new Date(stabilityTest.test_ended) : null;
    const dt = stabilityTest.test_time ? new Date(stabilityTest.test_time) : null;
    const tag = stabilityTest.test_tag || stabilityTest.trace?.tag;
    const notes = stabilityTest.test_notes || stabilityTest.trace?.notes;
    const headBits = [];
    if (started) headBits.push(`Inicio: ${started.toLocaleString('pt-BR')}`);
    else if (dt) headBits.push(`Teste: ${dt.toLocaleString('pt-BR')}`);
    if (ended) headBits.push(`Fim: ${ended.toLocaleString('pt-BR')}`);
    if (tag) headBits.push(`Tag: ${tag}`);
    if (notes) headBits.push(`Obs: ${notes}`);
    const head = headBits.length
      ? `<div style="font-size:0.7rem;color:rgba(255,255,255,0.55);margin:2px 0 8px;">${headBits.join(' | ')}</div>`
      : '';
    html += `
      <div style="margin-top:6px;">
        <div style="font-size:0.75rem;color:#00d9ff;font-weight:600;margin-bottom:4px;">Teste de Estabilidade (Soak)</div>
        ${head}
        ${buildStabilitySummaryHtml(stabilityTest)}
      </div>
    `;
  }

  // Append raw transitions log if available
  if (rawTransitions.length > 0) {
    html += `
      <details style="margin-top:8px;">
        <summary style="cursor:pointer;font-size:0.72rem;color:rgba(255,255,255,0.5);user-select:none;">
          Transições individuais (${rawTransitions.length})
        </summary>
        <div style="margin-top:6px;">${_buildRawTransitionsHtml(rawTransitions)}</div>
      </details>`;
  }

  content.innerHTML = html;
  section.style.display = 'block';
}

/**
 * Build HTML table for raw transition entries from log files.
 */
function _buildRawTransitionsHtml(transitions) {
  if (!transitions || !transitions.length) return '';

  const classColor = (cls) => _classColor(cls);

  // Summary stats
  const times = transitions.map(t => t.duration_s).filter(v => Number.isFinite(v));
  const avgTime = times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : '--';
  const directions = {};
  for (const t of transitions) {
    const dir = `${t.from}→${t.to}`;
    if (!directions[dir]) directions[dir] = { count: 0, times: [] };
    directions[dir].count++;
    if (Number.isFinite(t.duration_s)) directions[dir].times.push(t.duration_s);
  }

  let dirSummary = '';
  for (const [dir, info] of Object.entries(directions)) {
    const avg = info.times.length ? (info.times.reduce((a, b) => a + b, 0) / info.times.length).toFixed(1) : '--';
    dirSummary += `<span style="margin-right:10px;">${dir}: <strong>${info.count}x</strong> (${avg}s)</span>`;
  }

  // Build row entries (most recent first, max 30)
  const display = transitions.slice(-30).reverse();
  let rows = '';
  for (const t of display) {
    const time = t.time || (t.server_time ? t.server_time.split(' ')[1] : '--');
    const dur = Number.isFinite(t.duration_s) ? `${t.duration_s}s` : '--';
    const conf = Number.isFinite(t.confidence) ? `${(t.confidence * 100).toFixed(0)}%` : '--';
    rows += `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
      <td style="padding:2px 6px;font-size:0.7rem;color:rgba(255,255,255,0.5);">${time}</td>
      <td style="padding:2px 6px;font-size:0.7rem;">
        <span style="color:${classColor(t.from)};">${t.from}</span>
        <span style="color:rgba(255,255,255,0.3);"> → </span>
        <span style="color:${classColor(t.to)};">${t.to}</span>
      </td>
      <td style="padding:2px 6px;font-size:0.7rem;color:#00ff88;font-family:'JetBrains Mono',monospace;">${dur}</td>
      <td style="padding:2px 6px;font-size:0.7rem;color:rgba(255,255,255,0.5);font-family:'JetBrains Mono',monospace;">${conf}</td>
    </tr>`;
  }

  return `
    <div style="margin-bottom:8px;">
      <div style="font-size:0.72rem;color:rgba(255,255,255,0.5);margin-bottom:6px;">
        ${transitions.length} transições | Média: ${avgTime}s
      </div>
      <div style="font-size:0.7rem;color:rgba(255,255,255,0.5);margin-bottom:8px;">${dirSummary}</div>
    </div>
    <div style="max-height:250px;overflow-y:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
          <th style="text-align:left;font-size:0.65rem;color:rgba(255,255,255,0.4);padding:2px 6px;">Hora</th>
          <th style="text-align:left;font-size:0.65rem;color:rgba(255,255,255,0.4);padding:2px 6px;">Transição</th>
          <th style="text-align:left;font-size:0.65rem;color:rgba(255,255,255,0.4);padding:2px 6px;">Tempo</th>
          <th style="text-align:left;font-size:0.65rem;color:rgba(255,255,255,0.4);padding:2px 6px;">Conf</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${transitions.length > 30 ? `<div style="font-size:0.65rem;color:rgba(255,255,255,0.35);margin-top:4px;">Mostrando últimas 30 de ${transitions.length}</div>` : ''}
  `;
}

function initTransitionLogSelector() {
  const select = document.getElementById('ttLogSelect');
  const refresh = document.getElementById('ttLogRefresh');
  if (refresh) refresh.addEventListener('click', () => loadTransitionLogList());
  if (select) {
    select.addEventListener('change', () => {
      const file = select.value;
      if (file) loadTransitionLogFile(file);
    });
  }
  loadTransitionLogList();
}

// =============================================================================
// ML PARAMETER SLIDERS
// =============================================================================

function initMLInspectPanel() {
  const toggleBtn = document.getElementById('mlInspectToggle');
  const panel = document.getElementById('mlInspectPanel');
  const arrow = document.getElementById('mlInspectArrow');
  if (!toggleBtn || !panel || !arrow) return;

  const storageKey = 'iot_dashboard_ml_inspect_open';

  const setOpen = (isOpen, persist) => {
    panel.classList.toggle('hidden', !isOpen);
    arrow.style.transform = isOpen ? 'rotate(90deg)' : 'rotate(0deg)';
    toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (persist) {
      try {
        localStorage.setItem(storageKey, isOpen ? '1' : '0');
      } catch (e) {
        // ignore storage failures (private mode, etc.)
      }
    }
  };

  let initialOpen = false;
  try {
    initialOpen = localStorage.getItem(storageKey) === '1';
  } catch (e) {
    initialOpen = false;
  }
  setOpen(initialOpen, false);

  toggleBtn.addEventListener('click', () => {
    const isOpen = panel.classList.contains('hidden');
    setOpen(isOpen, true);
  });
}

const ML_PARAM_SLIDERS = [
  { id: 'mlParamWindowSize',       key: 'WINDOW_SIZE',         valId: 'mlParamWindowSizeVal',       fmt: v => v },
  { id: 'mlParamMinPoints',        key: 'MIN_POINTS',          valId: 'mlParamMinPointsVal',        fmt: v => v },
  { id: 'mlParamSmoothingAlpha',   key: 'SMOOTHING_ALPHA',     valId: 'mlParamSmoothingAlphaVal',   fmt: v => parseFloat(v).toFixed(2) },
  { id: 'mlParamHysteresisCount',  key: 'HYSTERESIS_COUNT',    valId: 'mlParamHysteresisCountVal',  fmt: v => v },
  { id: 'mlParamChangeDetectRatio',key: 'CHANGE_DETECT_RATIO', valId: 'mlParamChangeDetectRatioVal',fmt: v => parseFloat(v).toFixed(2) },
  { id: 'mlParamFastFlushKeep',    key: 'FAST_FLUSH_KEEP',     valId: 'mlParamFastFlushKeepVal',    fmt: v => v },
];

function initMLParamSliders() {
  const cfg = window.ClassifierConfig;
  if (!cfg) return;

  // Restore auto-tuned params from localStorage
  try {
    const stored = localStorage.getItem(AUTO_TUNE_STORAGE_KEY);
    if (stored) {
      const { params } = JSON.parse(stored);
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (key in cfg) cfg[key] = value;
        }
        _updateAutoTuneBadge(true);
      }
    }
  } catch (e) { /* ignore */ }

  // Toggle arrow on details open/close
  const details = document.getElementById('mlParamsDetails');
  const arrow = document.getElementById('mlParamsArrow');
  if (details && arrow) {
    details.addEventListener('toggle', () => {
      arrow.style.transform = details.open ? 'rotate(90deg)' : 'rotate(0deg)';
    });
  }

  ML_PARAM_SLIDERS.forEach(({ id, key, valId, fmt }) => {
    const slider = document.getElementById(id);
    const valEl = document.getElementById(valId);
    if (!slider || !valEl) return;

    slider.value = cfg[key];
    valEl.textContent = fmt(cfg[key]);

    slider.addEventListener('input', () => {
      const v = key === 'SMOOTHING_ALPHA' || key === 'CHANGE_DETECT_RATIO'
        ? parseFloat(slider.value)
        : parseInt(slider.value, 10);
      cfg[key] = v;
      valEl.textContent = fmt(v);

      // Resize buffer when WINDOW_SIZE changes
      if (key === 'WINDOW_SIZE' && window.fanClassifier) {
        const buf = window.fanClassifier.buffer;
        if (buf && buf.maxSize !== v) {
          const arrays = buf.getArrays();
          const n = buf.size;
          buf.maxSize = v;
          buf.buffer = new Array(v);
          buf.head = 0;
          buf.count = 0;
          const start = Math.max(0, n - v);
          for (let i = start; i < n; i++) {
            buf.push({
              ax: arrays.ax[i], ay: arrays.ay[i], az: arrays.az[i],
              gx: arrays.gx[i], gy: arrays.gy[i], gz: arrays.gz[i],
              vib: arrays.vib[i], timestamp: Date.now()
            });
          }
        }
      }

      updateMLDecisionMeta();
    });
  });

  // Reset defaults button
  const resetBtn = document.getElementById('mlParamsReset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      cfg.reset();
      ML_PARAM_SLIDERS.forEach(({ id, key, valId, fmt }) => {
        const slider = document.getElementById(id);
        const valEl = document.getElementById(valId);
        if (slider) slider.value = cfg[key];
        if (valEl) valEl.textContent = fmt(cfg[key]);
      });
      localStorage.removeItem(AUTO_TUNE_STORAGE_KEY);
      _updateAutoTuneBadge(false);
      updateMLDecisionMeta();
    });
  }
}

// Initialize chart tension from localStorage
window.CHART_TENSION = parseFloat(localStorage.getItem('chartTension') || '0');

function initTensionSlider() {
  const slider = document.getElementById('chartTensionSlider');
  const valEl = document.getElementById('chartTensionVal');
  if (!slider || !valEl) return;

  slider.value = window.CHART_TENSION;
  valEl.textContent = window.CHART_TENSION.toFixed(2);

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    window.CHART_TENSION = v;
    valEl.textContent = v.toFixed(2);
    localStorage.setItem('chartTension', v);

    const allCharts = [tempChart, accelChart, gyroChart, vibrationChart, accelXChart, accelYChart, accelZChart, gyroXChart, gyroYChart, gyroZChart];
    allCharts.forEach(chart => {
      chart.data.datasets.forEach(ds => { ds.tension = v; });
      chart.update('none');
    });
  });
}

// --- Frequency Analyzer (real-time sampling rate bar) ---
let freqAnalyzerInterval = null;
let freqConfiguredHz = null; // cached from API config

async function updateFreqAnalyzer() {
  const cardEl = document.getElementById('freqAnalyzerCard');
  if (!cardEl) return;
  try {
    const res = await fetch(withDeviceId('../api/get_data?mode=history&seconds=60'));
    const json = await res.json();
    const items = Array.isArray(json) ? json : (json.data || []);
    const totalSamples = items.length;

    // Read configured Hz from API payload (runtime first, then config fallback)
    const runtimeConfiguredHz = Number(json?.runtime?.configured?.sample_rate_hz);
    const configSampleRateHz = Number(json?.config?.sample_rate);
    if (Number.isFinite(runtimeConfiguredHz) && runtimeConfiguredHz > 0) {
      freqConfiguredHz = runtimeConfiguredHz;
      lastServerConfig = { ...lastServerConfig, sample_rate: runtimeConfiguredHz };
    } else if (Number.isFinite(configSampleRateHz) && configSampleRateHz > 0) {
      freqConfiguredHz = configSampleRateHz;
      lastServerConfig = { ...lastServerConfig, sample_rate: freqConfiguredHz };
    }
    const configuredHz = Number.isFinite(Number(freqConfiguredHz))
      ? Number(freqConfiguredHz)
      : (Number.isFinite(Number(lastServerConfig?.sample_rate))
        ? Number(lastServerConfig.sample_rate)
        : 4);

    const confEl = document.getElementById('freqConfigured');
    const realEl = document.getElementById('freqReal');
    const devEl = document.getElementById('freqDeviation');
    const intervalEl = document.getElementById('freqInterval');
    const jitterEl = document.getElementById('freqJitter');
    const samplesEl = document.getElementById('freqSamples');
    const statusEl = document.getElementById('freqStatus');
    const progEl = document.getElementById('freqProgress');

    if (confEl) confEl.textContent = configuredHz + ' Hz';

    if (totalSamples < 2) {
      if (realEl) realEl.textContent = '-- Hz';
      if (devEl) devEl.textContent = '--%';
      if (intervalEl) intervalEl.textContent = '-- s';
      if (jitterEl) jitterEl.textContent = '-- s';
      if (samplesEl) samplesEl.textContent = totalSamples;
      if (statusEl) { statusEl.textContent = 'Aguardando'; statusEl.className = 'freq-stat-value'; }
      if (progEl) { progEl.style.width = '0%'; }
      return;
    }

    // Extract and sort timestamps (stored as DOUBLE seconds)
    const timestamps = items
      .map(d => parseFloat(d.timestamp))
      .filter(t => Number.isFinite(t))
      .sort((a, b) => a - b);

    if (timestamps.length < 2) return;

    // Compute intervals, ignoring gaps > 5s (pauses/reconnections)
    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      const dt = timestamps[i] - timestamps[i - 1];
      if (dt > 0 && dt < 5) intervals.push(dt);
    }

    let realHz = 0;
    let intervalMean = 0;
    let intervalStd = 0;

    if (intervals.length > 0) {
      intervalMean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
      const variance = intervals.reduce((s, v) => s + (v - intervalMean) ** 2, 0) / intervals.length;
      intervalStd = Math.sqrt(variance);
      realHz = intervalMean > 0 ? 1 / intervalMean : 0;
    } else {
      const duration = timestamps[timestamps.length - 1] - timestamps[0];
      if (duration > 0) {
        realHz = (timestamps.length - 1) / duration;
        intervalMean = duration / (timestamps.length - 1);
      }
    }

    const deviation = configuredHz > 0 ? Math.abs(realHz - configuredHz) / configuredHz * 100 : 0;
    const jitterRatio = intervalMean > 0 ? intervalStd / intervalMean : 0;
    const devClass = deviation < 15 ? 'freq-ok' : deviation < 30 ? 'freq-warn' : 'freq-bad';
    const jitterClass = jitterRatio < 0.3 ? 'freq-ok' : jitterRatio < 0.5 ? 'freq-warn' : 'freq-bad';

    if (realEl) { realEl.textContent = realHz.toFixed(2) + ' Hz'; realEl.className = 'freq-stat-value ' + devClass; }
    if (devEl) { devEl.textContent = deviation.toFixed(1) + '%'; devEl.className = 'freq-stat-value ' + devClass; }
    if (intervalEl) { intervalEl.textContent = intervalMean.toFixed(4) + ' s'; }
    if (jitterEl) { jitterEl.textContent = '\u00B1' + intervalStd.toFixed(4) + ' s'; jitterEl.className = 'freq-stat-value ' + jitterClass; }
    if (samplesEl) samplesEl.textContent = totalSamples;

    if (statusEl) {
      if (deviation < 15) {
        statusEl.textContent = 'OK'; statusEl.className = 'freq-stat-value freq-ok';
      } else if (deviation < 30) {
        statusEl.textContent = 'ALERTA'; statusEl.className = 'freq-stat-value freq-warn';
      } else {
        statusEl.textContent = 'CRITICO'; statusEl.className = 'freq-stat-value freq-bad';
      }
    }

    if (progEl) {
      const accuracy = Math.max(0, 100 - deviation);
      progEl.style.width = accuracy + '%';
      progEl.style.background = deviation < 15 ? '#22c55e' : deviation < 30 ? '#f59e0b' : '#ef4444';
    }
  } catch (e) {
    // silent
  }
}

function startFreqAnalyzer() {
  if (document.getElementById('freqAnalyzerCard')) {
    updateFreqAnalyzer();
    freqAnalyzerInterval = setInterval(updateFreqAnalyzer, 3000);
  }
}

function goToSoakAbsorption() {
  const row = document.getElementById('transitionTestRow');
  if (row) {
    const hidden = row.style.display === 'none' || getComputedStyle(row).display === 'none';
    if (hidden) row.style.display = '';
  }

  const absorb = document.getElementById('olAbsorbSection');
  const absorbVisible = absorb && getComputedStyle(absorb).display !== 'none';
  const target = absorbVisible ? absorb : document.getElementById('stabilityTestCard');
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  if (absorb) {
    absorb.classList.add('ol-attention');
    setTimeout(() => absorb.classList.remove('ol-attention'), 1300);
  }
}

async function startApp() {
  if (window.appStarted) return;
  window.appStarted = true;

  const mlToggleBtn = document.getElementById('mlToggle');
  const mlResetBtn = document.getElementById('mlReset');

  if (mlToggleBtn) mlToggleBtn.addEventListener('click', toggleML);
  if (mlResetBtn) mlResetBtn.addEventListener('click', resetML);

  // Transition test controls
  const testToggleBtn = document.getElementById('mlTestToggle');
  const testCard = document.getElementById('transitionTestRow');
  if (testToggleBtn && testCard) {
    testToggleBtn.addEventListener('click', () => {
      const hidden = testCard.style.display === 'none' || getComputedStyle(testCard).display === 'none';
      // Let CSS decide the layout (grid-2x1 is flex). Avoid forcing display:block.
      testCard.style.display = hidden ? '' : 'none';
    });
  }
  const testStartBtn = document.getElementById('testStartBtn');
  const testStopBtn = document.getElementById('testStopBtn');
  if (testStartBtn) testStartBtn.addEventListener('click', () => TransitionTest.start());
  if (testStopBtn) testStopBtn.addEventListener('click', () => TransitionTest.stop());

  const stStartBtn = document.getElementById('stStartBtn');
  const stStopBtn = document.getElementById('stStopBtn');
  if (stStartBtn) stStartBtn.addEventListener('click', () => StabilityTest.start());
  if (stStopBtn) stStopBtn.addEventListener('click', () => StabilityTest.stop());

  // Online Learning controls
  document.getElementById('olResetBtn')?.addEventListener('click', async () => {
    if (confirm('Resetar modelo para o original? Todo aprendizado online sera perdido.')) {
      await OnlineLearning.resetToBase();
    }
  });
  document.getElementById('olExportBtn')?.addEventListener('click', () => {
    OnlineLearning.exportAdaptedModel();
  });
  document.getElementById('olGoToSoakBtn')?.addEventListener('click', () => {
    goToSoakAbsorption();
  });
  document.getElementById('olClearPendingBtn')?.addEventListener('click', () => {
    OnlineLearning.clearPendingSession();
  });
  OnlineLearning._renderPendingSession();

  initTransitionLogSelector();

  // ML inspect (collapse) panel
  initMLInspectPanel();

  // Continuous drift monitor (model + mechanical)
  DriftMonitor.init();

  // ML Parameter sliders
  initMLParamSliders();

  // Model reference (feature params) panel
  initModelParamsUI();

  const rateEl = document.getElementById('headerRate');
  if (rateEl) rateEl.textContent = `@ ${currentDashboardRateHz} Hz`;

  injectPlaybackControls();
  await loadPerClassBaselines();
  injectPerClassReferenceStrips();
  initTensionSlider();

  // Listener para comandos do painel de controle (control.html)
  try {
    const controlChannel = new BroadcastChannel('fan_control_channel');
    controlChannel.onmessage = (event) => {
      if (event.data?.type === 'MODE_CHANGE') {
        smartResetClassifier();
      }
    };
  } catch (e) {
    console.warn("BroadcastChannel não é suportado neste navegador.", e);
  }

  await initMLClassifier();
  setMLDataOnline(false);
  startDataFetching();
  startFreqAnalyzer();

  // Periodic freshness check: mark offline if no fresh data
  setInterval(() => {
    if (!isFresh()) {
      updateStatus(false);
    }
  }, 2000);
}

document.addEventListener('DOMContentLoaded', startApp);
if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(startApp, 100);


