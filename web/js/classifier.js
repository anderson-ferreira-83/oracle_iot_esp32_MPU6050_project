/**
 * classifier.js - Fan Speed Classifier v6.0
 *
 * Features:
 * - N-class Gaussian NB (supports 3-class legacy and 7-class composite)
 * - No zone-based detection - uses real trained statistics
 * - Circular buffer for O(1) operations
 * - Hysteresis for stability with adjacency-based asymmetric rules
 * - Bayesian Online Learning: bayesianUpdate(), exportModel()
 *
 * @version 6.0.0
 * @author IoT MPU6050 Project
 */

// =============================================================================
// CLASS LABELS CONFIG (shared with dashboard.js)
// =============================================================================

const ClassLabels = {
    ORDER: ['LOW_ROT_ON','MEDIUM_ROT_ON','HIGH_ROT_ON','LOW_ROT_OFF','MEDIUM_ROT_OFF','HIGH_ROT_OFF','FAN_OFF'],
    SHORT: {
        LOW_ROT_ON: 'LO_ON', MEDIUM_ROT_ON: 'MD_ON', HIGH_ROT_ON: 'HI_ON',
        LOW_ROT_OFF: 'LO_OFF', MEDIUM_ROT_OFF: 'MD_OFF', HIGH_ROT_OFF: 'HI_OFF',
        FAN_OFF: 'OFF',
        // Legacy 3-class
        LOW: 'LOW', MEDIUM: 'MED', HIGH: 'HIGH',
    },
    COLORS: {
        LOW_ROT_ON: '#00d9ff',    MEDIUM_ROT_ON: '#00ff88',   HIGH_ROT_ON: '#ff5252',
        LOW_ROT_OFF: '#7ecfdf',   MEDIUM_ROT_OFF: '#7edf9a',  HIGH_ROT_OFF: '#df7e7e',
        FAN_OFF: '#9ca3af',
        // Legacy 3-class
        LOW: '#00d9ff', MEDIUM: '#00ff88', HIGH: '#ff5252',
    },
    DESCRIPTIONS: {
        LOW_ROT_ON: 'Velocidade baixa (girando)',
        MEDIUM_ROT_ON: 'Velocidade média (girando)',
        HIGH_ROT_ON: 'Velocidade alta (girando)',
        LOW_ROT_OFF: 'Velocidade baixa (parado)',
        MEDIUM_ROT_OFF: 'Velocidade média (parado)',
        HIGH_ROT_OFF: 'Velocidade alta (parado)',
        FAN_OFF: 'Ventilador desligado',
        // Legacy 3-class
        LOW: 'Velocidade baixa',
        MEDIUM: 'Velocidade média',
        HIGH: 'Velocidade alta',
    },
    // Legacy: maps old labels (3-class models) to new
    LEGACY_MAP: { LOW: 'LOW_ROT_ON', MEDIUM: 'MEDIUM_ROT_ON', HIGH: 'HIGH_ROT_ON' },
};

window.ClassLabels = ClassLabels;

// =============================================================================
// CONFIGURATION
// =============================================================================

const ClassifierConfig = {
    // Tamanho da Janela Deslizante: Quantos pontos passados analisamos de uma vez
    // 100 pontos a ~15Hz = ~6.7s de dados (estabiliza skew/kurtosis)
    // Deve ser igual ao window_size usado no treinamento do modelo
    WINDOW_SIZE: 100,

    // Minimo de pontos no buffer para iniciar classificacao
    // 40 pontos a ~15Hz = ~2.7s para primeira predicao
    // Reduzido de 50: modelo v6 com 25 features e robusto o suficiente
    MIN_POINTS: 40,

    // Confidence thresholds
    CONFIDENCE_HIGH: 0.70,
    CONFIDENCE_MEDIUM: 0.55,
    CONFIDENCE_GATE: 0.55,          // Reduzido de 0.60: modelo v6 tem confianca mais alta em geral
    CONFIDENCE_MARGIN: 0.12,        // Reduzido de 0.15: menos margem necessaria com 25 features

    // Regras assimetricas para transicoes adjacentes (classes vizinhas na ordem do modelo)
    // Exige confianca mais alta para evitar falsos positivos entre classes proximas.
    ADJACENT_TRANSITION_CONFIDENCE_GATE: 0.95,
    ADJACENT_TRANSITION_CONFIDENCE_MARGIN: 0.12,
    ADJACENT_TRANSITION_HYSTERESIS_COUNT: 5,

    // Update frequency
    PREDICTION_INTERVAL_MS: 250,

    // Smoothing: peso dado a nova leitura vs historico
    // Maior alpha = reage mais rapido a mudancas reais
    // Modelo v6 com 0 erros LOW<->MEDIUM permite alpha maior sem flickering
    SMOOTHING_ALPHA: 0.65,

    // Histerese: Exige N predicoes consecutivas iguais antes de mudar estado
    // Reduzido de 4 para 3: modelo v6 mais preciso requer menos confirmacoes
    // 3 x 200ms = 600ms de atraso na transicao (era 800ms)
    HYSTERESIS_COUNT: 3,

    // Taxa de amostragem do sensor (Hz) — usada para FFT features
    SAMPLING_HZ: 20.0,

    // Deteccao de mudanca brusca: monitora gyro_z_dps P95
    // Compara ultimos N pontos com primeira metade do buffer
    // Se ratio P95_recente/P95_antigo sair do intervalo, faz flush parcial
    CHANGE_DETECT_WINDOW: 20,       // ultimos 20 pontos (~1.3s) para detectar mudanca
    CHANGE_DETECT_RATIO: 0.25,      // Reduzido de 0.30: detecta transicoes HIGH->LOW mais cedo
    FAST_FLUSH_KEEP: 30,            // Aumentado de 25 para 30: mantem mais contexto pos-flush
    CHANGE_DETECT_COOLDOWN: 10000,  // Reduzido de 15s para 10s: permite reagir a transicoes consecutivas

    // Defaults for reset
    _DEFAULTS: {
        WINDOW_SIZE: 100,
        MIN_POINTS: 40,
        SMOOTHING_ALPHA: 0.65,
        HYSTERESIS_COUNT: 3,
        CHANGE_DETECT_RATIO: 0.25,
        FAST_FLUSH_KEEP: 30,
        CHANGE_DETECT_COOLDOWN: 10000,
        ADJACENT_TRANSITION_CONFIDENCE_GATE: 0.95,
        ADJACENT_TRANSITION_CONFIDENCE_MARGIN: 0.12,
        ADJACENT_TRANSITION_HYSTERESIS_COUNT: 5,
    },

    reset() {
        for (const [key, value] of Object.entries(this._DEFAULTS)) {
            this[key] = value;
        }
    },

    /**
     * Compute auto-tune recommendations from soak test segments.
     * Returns 3 modes: 'full' (5 params), 'partial' (2 params), 'diagnostic' (analysis only).
     * NEVER returns null — always provides at least a diagnostic.
     *
     * @param {Array} segments - soak test segment objects
     * @returns {object} { mode, quality, recommendations?, latency?, diagnostic }
     */
    computeAutoTune(segments) {
        if (!segments || !Array.isArray(segments)) {
            return { mode: 'diagnostic', diagnostic: { message: 'Nenhum segmento fornecido.', perClass: {} } };
        }

        const validSegs = segments.filter(s => s && s.target);
        if (validSegs.length === 0) {
            return { mode: 'diagnostic', diagnostic: { message: 'Nenhum segmento válido.', perClass: {} } };
        }

        // --- Per-class diagnostic ---
        const classMap = {};
        for (const seg of validSegs) {
            const label = seg.target;
            if (!classMap[label]) classMap[label] = [];
            classMap[label].push(seg);
        }

        const diagnostic = { perClass: {} };
        for (const [label, segs] of Object.entries(classMap)) {
            const ratios = segs.map(s => s.target_ratio).filter(v => v != null);
            const confs = segs.map(s => s.confidence?.mean).filter(v => v != null);
            const avgTargetRatio = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
            const avgConfidence = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
            diagnostic.perClass[label] = {
                segments: segs.length,
                avgTargetRatio,
                avgConfidence,
                problematic: avgTargetRatio < 0.50,
            };
        }

        const classes = new Set(validSegs.map(s => s.target));
        const targetRatios = validSegs.map(s => s.target_ratio).filter(v => v != null);
        const confMeans = validSegs.map(s => s.confidence?.mean).filter(v => v != null);
        const meanConf = confMeans.length > 0 ? confMeans.reduce((a, b) => a + b, 0) / confMeans.length : 0;
        const minTargetRatio = targetRatios.length > 0 ? Math.min(...targetRatios) : 0;

        // --- Helper functions ---
        const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
        const roundTo = (v, step) => Math.round(v / step) * step;

        const estLatency = (alpha, hyst) => {
            const smoothing_ms = (1 / alpha) * 200 * 2;
            const hysteresis_ms = hyst * 200;
            return Math.round(smoothing_ms + hysteresis_ms);
        };

        // --- Collect common metrics ---
        const flipsArr = validSegs.map(s => s.flips_per_min).filter(v => v != null);
        const maxFlips = flipsArr.length > 0 ? Math.max(...flipsArr) : 0;

        const tttArr = validSegs.map(s => s.time_to_target_s).filter(v => v != null && v > 0);
        tttArr.sort((a, b) => a - b);
        const medianTTT = tttArr.length > 0 ? tttArr[Math.floor(tttArr.length / 2)] : 2;

        // --- Check for FULL mode gates ---
        const fullGateOk = validSegs.length >= 3 && classes.size >= 2 &&
            minTargetRatio >= 0.80 && meanConf >= 0.60;

        // --- Check for PARTIAL mode gates ---
        const classesWithGoodRatio = Object.entries(diagnostic.perClass)
            .filter(([, info]) => info.avgTargetRatio >= 0.50);
        const partialGateOk = !fullGateOk && validSegs.length >= 2 &&
            classesWithGoodRatio.length >= 1;

        if (fullGateOk) {
            // FULL mode: 5 parameters (original logic)
            const qualityScore = clamp(0, 1, (meanConf - 0.55) / 0.40);
            const rawAlpha = 0.50 + 0.40 * qualityScore;
            const recAlpha = roundTo(clamp(0.55, 0.90, rawAlpha), 0.05);
            const recHyst = maxFlips < 1 ? 2 : maxFlips < 3 ? 3 : maxFlips < 6 ? 4 : 5;

            // Analyze weakest class for adjacent transition tuning
            let worstClassConf = 1, worstClassFlips = 0, worstClassGap = 1;
            for (const [, segs] of Object.entries(classMap)) {
                const cMeans = segs.map(s => s.confidence?.mean).filter(v => v != null);
                const mc = cMeans.length > 0 ? cMeans.reduce((a, b) => a + b, 0) / cMeans.length : 0;
                const cFlips = segs.map(s => s.flips_per_min).filter(v => v != null);
                const mf = cFlips.length > 0 ? Math.max(...cFlips) : 0;
                const cGaps = segs.map(s => s.confidence_gap?.mean).filter(v => v != null);
                const mg = cGaps.length > 0 ? cGaps.reduce((a, b) => a + b, 0) / cGaps.length : 0;
                if (mc < worstClassConf) worstClassConf = mc;
                if (mf > worstClassFlips) worstClassFlips = mf;
                if (mg < worstClassGap) worstClassGap = mg;
            }

            let recAdjGate = 0.95;
            if (worstClassConf > 0.90 && worstClassGap > 0.30) recAdjGate = 0.75;
            else if (worstClassConf > 0.80) recAdjGate = 0.85;

            const recAdjHyst = worstClassFlips < 1 ? 3 : worstClassFlips < 2 ? 4 : 5;
            const recCDR = medianTTT > 3 ? 0.20 : medianTTT > 1.5 ? 0.25 : 0.35;

            const recommendations = {
                SMOOTHING_ALPHA: recAlpha,
                HYSTERESIS_COUNT: recHyst,
                ADJACENT_TRANSITION_CONFIDENCE_GATE: recAdjGate,
                ADJACENT_TRANSITION_HYSTERESIS_COUNT: recAdjHyst,
                CHANGE_DETECT_RATIO: recCDR,
            };

            const currentGeneral = estLatency(this.SMOOTHING_ALPHA, this.HYSTERESIS_COUNT);
            const tunedGeneral = estLatency(recAlpha, recHyst);
            const currentAdj = estLatency(this.SMOOTHING_ALPHA, this.ADJACENT_TRANSITION_HYSTERESIS_COUNT);
            const tunedAdj = estLatency(recAlpha, recAdjHyst);

            return {
                mode: 'full',
                quality: {
                    score: qualityScore,
                    meanConf,
                    maxFlips,
                    medianTTT,
                    segmentCount: validSegs.length,
                    classCount: classes.size,
                },
                recommendations,
                latency: {
                    current_general_ms: currentGeneral,
                    tuned_general_ms: tunedGeneral,
                    current_adj_ms: currentAdj,
                    tuned_adj_ms: tunedAdj,
                    improvement_pct: currentGeneral > 0 ? Math.round((1 - tunedGeneral / currentGeneral) * 100) : 0,
                    improvement_adj_pct: currentAdj > 0 ? Math.round((1 - tunedAdj / currentAdj) * 100) : 0,
                },
                diagnostic,
            };
        }

        if (partialGateOk) {
            // PARTIAL mode: only SMOOTHING_ALPHA + HYSTERESIS_COUNT
            const qualityScore = clamp(0, 1, (meanConf - 0.55) / 0.40);
            const rawAlpha = 0.50 + 0.40 * qualityScore;
            const recAlpha = roundTo(clamp(0.55, 0.90, rawAlpha), 0.05);
            const recHyst = maxFlips < 1 ? 2 : maxFlips < 3 ? 3 : maxFlips < 6 ? 4 : 5;

            const currentGeneral = estLatency(this.SMOOTHING_ALPHA, this.HYSTERESIS_COUNT);
            const tunedGeneral = estLatency(recAlpha, recHyst);

            return {
                mode: 'partial',
                quality: {
                    score: qualityScore,
                    meanConf,
                    maxFlips,
                    medianTTT,
                    segmentCount: validSegs.length,
                    classCount: classes.size,
                },
                recommendations: {
                    SMOOTHING_ALPHA: recAlpha,
                    HYSTERESIS_COUNT: recHyst,
                },
                latency: {
                    current_general_ms: currentGeneral,
                    tuned_general_ms: tunedGeneral,
                    improvement_pct: currentGeneral > 0 ? Math.round((1 - tunedGeneral / currentGeneral) * 100) : 0,
                },
                diagnostic,
            };
        }

        // DIAGNOSTIC mode: no apply button, just analysis
        const problematicClasses = Object.entries(diagnostic.perClass)
            .filter(([, info]) => info.problematic)
            .map(([label]) => label);

        diagnostic.message = problematicClasses.length > 0
            ? `Classes problemáticas: ${problematicClasses.join(', ')}. Use Health Check ou Recalibração Rápida.`
            : `Dados insuficientes (${validSegs.length} segs, ${classes.size} classes). Rode Soak Test com mais tempo.`;

        return {
            mode: 'diagnostic',
            quality: {
                score: 0,
                meanConf,
                maxFlips,
                medianTTT,
                segmentCount: validSegs.length,
                classCount: classes.size,
            },
            diagnostic,
        };
    },
};

// =============================================================================
// CIRCULAR BUFFER
// Estrutura de dados eficiente para guardar sempre os últimos N pontos
// =============================================================================

class CircularBuffer {
    constructor(maxSize = ClassifierConfig.WINDOW_SIZE) {
        this.maxSize = maxSize;
        this.buffer = new Array(maxSize);
        this.head = 0;
        this.count = 0;
    }

    // Adiciona um novo ponto e sobrescreve o mais antigo se estiver cheio
    push(point) {
        this.buffer[this.head] = {
            ax: point.ax || point.AX || point.accel_x_g || 0,
            ay: point.ay || point.AY || point.accel_y_g || 0,
            az: point.az || point.AZ || point.accel_z_g || 0,
            gx: point.gx || point.GX || point.gyro_x_dps || 0,
            gy: point.gy || point.GY || point.gyro_y_dps || 0,
            gz: point.gz || point.GZ || point.gyro_z_dps || 0,
            vib: point.vib || point.vibration || point.VIB || point.vibration_dps || point.vibrationDps || 0,
            timestamp: point.timestamp || Date.now()
        };
        this.head = (this.head + 1) % this.maxSize;
        if (this.count < this.maxSize) this.count++;
    }

    get size() { return this.count; }
    get isReady() { return this.count >= ClassifierConfig.MIN_POINTS; }

    // Retorna os dados organizados em arrays separados por eixo (para facilitar cálculos matemáticos)
    getArrays() {
        const result = {
            ax: new Array(this.count),
            ay: new Array(this.count),
            az: new Array(this.count),
            gx: new Array(this.count),
            gy: new Array(this.count),
            gz: new Array(this.count),
            vib: new Array(this.count)
        };

        for (let i = 0; i < this.count; i++) {
            const idx = (this.head - this.count + i + this.maxSize) % this.maxSize;
            const point = this.buffer[idx];
            result.ax[i] = point.ax;
            result.ay[i] = point.ay;
            result.az[i] = point.az;
            result.gx[i] = point.gx;
            result.gy[i] = point.gy;
            result.gz[i] = point.gz;
            result.vib[i] = point.vib;
        }
        return result;
    }

    clear() {
        this.buffer = new Array(this.maxSize);
        this.head = 0;
        this.count = 0;
    }
}

// =============================================================================
// STATISTICAL FUNCTIONS
// =============================================================================

const Stats = {
    // Média aritmética
    mean(arr) {
        if (!arr || arr.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += arr[i];
        return sum / arr.length;
    },

    // Desvio Padrão populacional (ddof=0) - alinhado com np.std(ddof=0) do Python
    std(arr) {
        if (!arr || arr.length < 2) return 0;
        const m = this.mean(arr);
        let sumSq = 0;
        for (let i = 0; i < arr.length; i++) {
            const diff = arr[i] - m;
            sumSq += diff * diff;
        }
        return Math.sqrt(sumSq / arr.length);
    },

    // RMS (Root Mean Square)
    rms(arr) {
        if (!arr || arr.length === 0) return 0;
        let sumSq = 0;
        for (let i = 0; i < arr.length; i++) sumSq += arr[i] * arr[i];
        return Math.sqrt(sumSq / arr.length);
    },

    // Peak: max dos valores absolutos (alinhado com np.max(np.abs(arr)) do treinamento)
    peak(arr) {
        if (!arr || arr.length === 0) return 0;
        let maxAbs = 0;
        for (let i = 0; i < arr.length; i++) {
            const v = Math.abs(arr[i]);
            if (v > maxAbs) maxAbs = v;
        }
        return maxAbs;
    },

    // Mean absolute value
    meanAbs(arr) {
        if (!arr || arr.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += Math.abs(arr[i]);
        return sum / arr.length;
    },

    // Root amplitude: (mean(sqrt(|x|)))^2
    rootAmplitude(arr) {
        if (!arr || arr.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += Math.sqrt(Math.abs(arr[i]));
        const m = sum / arr.length;
        return m * m;
    },

    // Skewness (bias=True, alinhado com scipy.stats.skew(bias=True))
    skew(arr) {
        if (!arr || arr.length < 3) return 0;
        const n = arr.length;
        const m = this.mean(arr);
        let m2 = 0, m3 = 0;
        for (let i = 0; i < n; i++) {
            const d = arr[i] - m;
            m2 += d * d;
            m3 += d * d * d;
        }
        m2 /= n;
        m3 /= n;
        const s = Math.sqrt(m2);
        if (s < 1e-10) return 0;
        return m3 / (s * s * s);
    },

    // Kurtosis (Fisher, bias=True, alinhado com scipy.stats.kurtosis(fisher=True, bias=True))
    kurtosis(arr) {
        if (!arr || arr.length < 4) return 0;
        const n = arr.length;
        const m = this.mean(arr);
        let m2 = 0, m4 = 0;
        for (let i = 0; i < n; i++) {
            const d = arr[i] - m;
            const d2 = d * d;
            m2 += d2;
            m4 += d2 * d2;
        }
        m2 /= n;
        m4 /= n;
        if (m2 < 1e-10) return 0;
        return (m4 / (m2 * m2)) - 3.0;
    },

    // Crest factor: peak / rms
    crestFactor(arr) {
        const r = this.rms(arr);
        return r > 1e-10 ? this.peak(arr) / r : 0;
    },

    // Shape factor: rms / meanAbs
    shapeFactor(arr) {
        const ma = this.meanAbs(arr);
        return ma > 1e-10 ? this.rms(arr) / ma : 0;
    },

    // Impulse factor: peak / meanAbs
    impulseFactor(arr) {
        const ma = this.meanAbs(arr);
        return ma > 1e-10 ? this.peak(arr) / ma : 0;
    },

    // Clearance factor: peak / rootAmplitude
    clearanceFactor(arr) {
        const ra = this.rootAmplitude(arr);
        return ra > 1e-10 ? this.peak(arr) / ra : 0;
    },

    // Range (mantido para compatibilidade)
    range(arr) {
        if (!arr || arr.length === 0) return 0;
        let min = arr[0], max = arr[0];
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] < min) min = arr[i];
            if (arr[i] > max) max = arr[i];
        }
        return max - min;
    },

    max(arr) {
        if (!arr || arr.length === 0) return 0;
        let max = arr[0];
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] > max) max = arr[i];
        }
        return max;
    },

    // Percentil (interpolacao linear, alinhado com np.percentile do Python)
    percentile(arr, p) {
        if (!arr || arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const n = sorted.length;
        const idx = (p / 100) * (n - 1);
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        if (lo === hi) return sorted[lo];
        return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
    },

    // RMS da energia de uma banda FFT [fLow, fHigh) Hz
    // Alinhado com compute_extended_features() do Python:
    //   spectrum = |rfft(arr - mean)|, freqs = rfftfreq(n, d=1/samplingHz)
    fftBandRms(arr, fLow, fHigh, samplingHz = 20.0) {
        if (!arr || arr.length === 0) return 0;
        const n = arr.length;
        // Remove DC (media)
        const m = this.mean(arr);
        // DFT real: k = 0..floor(n/2)
        const nFreqs = Math.floor(n / 2) + 1;
        let sumSq = 0;
        let count = 0;
        for (let k = 0; k < nFreqs; k++) {
            const f = k * samplingHz / n;
            if (f < fLow || f >= fHigh) continue;
            // Calcular magnitude do bin k: |sum_j x[j] * exp(-2pi*i*k*j/n)|
            let re = 0, im = 0;
            const angle = -2 * Math.PI * k / n;
            for (let j = 0; j < n; j++) {
                const a = angle * j;
                re += (arr[j] - m) * Math.cos(a);
                im += (arr[j] - m) * Math.sin(a);
            }
            const mag = Math.sqrt(re * re + im * im);
            sumSq += mag * mag;
            count++;
        }
        return count === 0 ? 0 : Math.sqrt(sumSq / count);
    }
};

// =============================================================================
// FEATURE EXTRACTOR
// =============================================================================


class FeatureExtractor {
    // Calcula 11 metricas estatisticas para um eixo
    // Alinhado com compute_features() do notebook 01 (ddof=0, bias=True)
    static _axisFeatures(arr, prefix) {
        return {
            [`${prefix}_mean`]: Stats.mean(arr),
            [`${prefix}_std`]: Stats.std(arr),
            [`${prefix}_skew`]: Stats.skew(arr),
            [`${prefix}_kurtosis`]: Stats.kurtosis(arr),
            [`${prefix}_rms`]: Stats.rms(arr),
            [`${prefix}_peak`]: Stats.peak(arr),
            [`${prefix}_root_amplitude`]: Stats.rootAmplitude(arr),
            [`${prefix}_crest_factor`]: Stats.crestFactor(arr),
            [`${prefix}_shape_factor`]: Stats.shapeFactor(arr),
            [`${prefix}_impulse_factor`]: Stats.impulseFactor(arr),
            [`${prefix}_clearance_factor`]: Stats.clearanceFactor(arr),
        };
    }

    static _metricValue(arr, metric, samplingHz = 20.0) {
        switch (metric) {
            case 'mean': return Stats.mean(arr);
            case 'std': return Stats.std(arr);
            case 'range': return Stats.range(arr);
            case 'skew': return Stats.skew(arr);
            case 'kurtosis': return Stats.kurtosis(arr);
            case 'rms': return Stats.rms(arr);
            case 'peak': return Stats.peak(arr);
            case 'root_amplitude': return Stats.rootAmplitude(arr);
            case 'crest_factor': return Stats.crestFactor(arr);
            case 'shape_factor': return Stats.shapeFactor(arr);
            case 'impulse_factor': return Stats.impulseFactor(arr);
            case 'clearance_factor': return Stats.clearanceFactor(arr);
            // Percentis (alinhados com np.percentile)
            case 'p10': return Stats.percentile(arr, 10);
            case 'p25': return Stats.percentile(arr, 25);
            case 'p75': return Stats.percentile(arr, 75);
            case 'p90': return Stats.percentile(arr, 90);
            case 'p95': return Stats.percentile(arr, 95);
            // Bandas FFT (alinhadas com scipy.fft.rfft no Python)
            case 'fft_low':  return Stats.fftBandRms(arr,  0.0,  5.0, samplingHz);
            case 'fft_mid':  return Stats.fftBandRms(arr,  5.0, 15.0, samplingHz);
            case 'fft_high': return Stats.fftBandRms(arr, 15.0, samplingHz / 2, samplingHz);
            default: return null;
        }
    }

    /**
     * Extrai features temporais (66) + percentis + FFT bands.
     * @param {object} data - { ax, ay, az, gx, gy, gz }
     * @param {Array|null} featureList - lista de features do modelo; null = extrair todas 66 basicas
     * @param {number} samplingHz - taxa de amostragem (Hz) para calculos FFT
     * @returns {object} feature dict
     */
    static extract(data, featureList = null, samplingHz = 20.0) {
        const { ax, ay, az, gx, gy, gz, vib } = data;
        const axes = {
            'accel_x_g': ax,
            'accel_y_g': ay,
            'accel_z_g': az,
            'gyro_x_dps': gx,
            'gyro_y_dps': gy,
            'gyro_z_dps': gz,
        };

        // Optional vibration axis (dashboard provides vib = vibration_dps or vibration)
        if (Array.isArray(vib) && vib.length) {
            axes['vibration'] = vib;
            axes['vibration_dps'] = vib;
        }

        if (!Array.isArray(featureList) || featureList.length === 0) {
            return {
                ...this._axisFeatures(ax, 'accel_x_g'),
                ...this._axisFeatures(ay, 'accel_y_g'),
                ...this._axisFeatures(az, 'accel_z_g'),
                ...this._axisFeatures(gx, 'gyro_x_dps'),
                ...this._axisFeatures(gy, 'gyro_y_dps'),
                ...this._axisFeatures(gz, 'gyro_z_dps'),
            };
        }

        // Derived axes (computed only when requested by the model feature list)
        const needsAccelMag = featureList.some(f => typeof f === 'string' && f.startsWith('accel_mag_g_'));
        const needsGyroMag = featureList.some(f => typeof f === 'string' && f.startsWith('gyro_mag_dps_'));
        if (needsAccelMag && Array.isArray(ax) && Array.isArray(ay) && Array.isArray(az)) {
            const n = Math.min(ax.length, ay.length, az.length);
            const mag = new Array(n);
            for (let i = 0; i < n; i++) {
                const x = ax[i] || 0;
                const y = ay[i] || 0;
                const z = az[i] || 0;
                mag[i] = Math.sqrt(x * x + y * y + z * z);
            }
            axes['accel_mag_g'] = mag;
        }
        if (needsGyroMag && Array.isArray(gx) && Array.isArray(gy) && Array.isArray(gz)) {
            const n = Math.min(gx.length, gy.length, gz.length);
            const mag = new Array(n);
            for (let i = 0; i < n; i++) {
                const x = gx[i] || 0;
                const y = gy[i] || 0;
                const z = gz[i] || 0;
                mag[i] = Math.sqrt(x * x + y * y + z * z);
            }
            axes['gyro_mag_dps'] = mag;
        }

        const features = {};
        const metricNames = [
            'clearance_factor',
            'impulse_factor',
            'shape_factor',
            'crest_factor',
            'root_amplitude',
            'fft_high',
            'fft_mid',
            'fft_low',
            'kurtosis',
            'skew',
            'rms',
            'peak',
            'range',
            'std',
            'mean',
            'p95',
            'p90',
            'p75',
            'p25',
            'p10',
        ];
        const cache = {};

        for (const feat of featureList) {
            let metric = null;
            for (const name of metricNames) {
                if (feat.endsWith(`_${name}`)) {
                    metric = name;
                    break;
                }
            }
            if (!metric) continue;
            const axisName = feat.slice(0, -(metric.length + 1));
            const arr = axes[axisName];
            if (!arr) continue;
            if (!cache[axisName]) cache[axisName] = {};
            if (cache[axisName][metric] === undefined) {
                cache[axisName][metric] = this._metricValue(arr, metric, samplingHz);
            }
            features[feat] = cache[axisName][metric];
        }

        return features;
    }
}

// =============================================================================
// GAUSSIAN NAIVE BAYES CLASSIFIER (N CLASSES)
// Algoritmo probabilístico que calcula qual a chance dos dados pertencerem a cada classe
// =============================================================================

class GaussianNBClassifier {
    constructor() {
        this.model = null;
        this.isLoaded = false;
    }

    // Carrega o arquivo JSON com as médias e variâncias treinadas
    async load(modelData) {
        try {
            let model = typeof modelData === 'string'
                ? await (await fetch(modelData)).json()
                : modelData;

            if (!model.features || !model.stats || !model.priors || !model.labels) {
                throw new Error('Model missing required fields');
            }

            this.model = model;
            this.isLoaded = true;

            console.log(`[Classifier] Model v${model.version} loaded: ${model.labels.length} classes, ${model.features.length} features`);
            console.log(`[Classifier] Classes: ${model.labels.join(', ')}`);

            return true;
        } catch (error) {
            console.error('[Classifier] Load failed:', error);
            this.isLoaded = false;
            return false;
        }
    }

    // Realiza a predição matemática
    predict(features) {
        if (!this.isLoaded) {
            return {
                prediction: 'UNKNOWN',
                confidence: 0,
                probabilities: {},
                error: 'Model not loaded'
            };
        }

        const labels = this.model.labels;
        const logProbs = {};

        // Para cada classe (LOW, MEDIUM, HIGH)...
        for (const label of labels) {
            logProbs[label] = Math.log(this.model.priors[label]);

            // ...somamos a probabilidade de cada feature (baseado na curva Gaussiana)
            for (const featureName of this.model.features) {
                const value = features[featureName];
                if (value === undefined || value === null) continue;

                // Pega a média e variância aprendidas no treinamento para essa feature nessa classe
                const stats = this.model.stats[label][featureName];
                if (!stats) continue;

                // Piso de variância: evita que features com variância ultra-baixa
                // (ex: 9e-7) dominem a classificação com z-scores extremos
                const variance = Math.max(stats.var, 1e-9);
                logProbs[label] += -0.5 * Math.log(2 * Math.PI * variance)
                    - Math.pow(value - stats.mean, 2) / (2 * variance);
            }
        }

        // Converte log-probabilidade de volta para porcentagem (0 a 1)
        const maxLogProb = Math.max(...Object.values(logProbs));
        const expProbs = {};
        let sumExp = 0;

        for (const label of labels) {
            expProbs[label] = Math.exp(logProbs[label] - maxLogProb);
            sumExp += expProbs[label];
        }

        const probabilities = {};
        for (const label of labels) {
            probabilities[label] = expProbs[label] / sumExp;
        }

        // Escolhe a classe com a maior probabilidade
        let prediction = labels[0];
        let maxProb = probabilities[labels[0]];

        for (const label of labels) {
            if (probabilities[label] > maxProb) {
                maxProb = probabilities[label];
                prediction = label;
            }
        }

        return {
            prediction,
            confidence: maxProb,
            probabilities
        };
    }

    /**
     * Compute drift z-scores: how far current feature values are from each class's
     * trained mean/var. Used by ModelHealthCheck to assess model freshness.
     *
     * @param {object} features - Current extracted features { featureName: value }
     * @returns {object} { perClass: { LOW: {meanZ, featureZScores}, ... },
     *                      bestClass, bestMeanZ, worstOverlap }
     */
    computeDrift(features) {
        if (!this.isLoaded || !features) return null;

        const labels = this.model.labels;
        const perClass = {};

        for (const label of labels) {
            const featureZScores = {};
            let sumZ = 0;
            let count = 0;

            for (const featureName of this.model.features) {
                const value = features[featureName];
                if (value === undefined || value === null) continue;

                const stats = this.model.stats[label]?.[featureName];
                if (!stats) continue;

                const variance = Math.max(stats.var, 1e-9);
                const z = Math.abs(value - stats.mean) / Math.sqrt(variance);
                featureZScores[featureName] = z;
                sumZ += z;
                count++;
            }

            perClass[label] = {
                meanZ: count > 0 ? sumZ / count : Infinity,
                featureZScores,
                featureCount: count,
            };
        }

        // Best class = lowest mean z-score (closest to model expectation)
        let bestClass = labels[0];
        let bestMeanZ = perClass[labels[0]]?.meanZ ?? Infinity;
        const sortedByZ = labels
            .map(l => ({ label: l, meanZ: perClass[l]?.meanZ ?? Infinity }))
            .sort((a, b) => a.meanZ - b.meanZ);

        bestClass = sortedByZ[0].label;
        bestMeanZ = sortedByZ[0].meanZ;

        // Overlap detection: if top-2 classes have similar meanZ (diff < 0.5)
        const worstOverlap = sortedByZ.length >= 2
            ? Math.abs(sortedByZ[0].meanZ - sortedByZ[1].meanZ) < 0.5
            : false;

        return { perClass, bestClass, bestMeanZ, worstOverlap };
    }

    /**
     * Suggest a lambda value based on divergence between session stats and model.
     *
     * @param {object} sessionStats - { className: { featureName: { n, mean, std } } }
     * @returns {object|null} { lambda, divergence, explanation, perClass }
     */
    computeSuggestedLambda(sessionStats) {
        if (!this.isLoaded || !sessionStats) return null;

        const labels = this.model.labels;
        const perClass = {};
        let maxDivergence = 0;
        let worstClass = null;

        for (const label of labels) {
            const classNewStats = sessionStats[label];
            if (!classNewStats) continue;

            const divergences = [];
            for (const featureName of this.model.features) {
                const newStat = classNewStats[featureName];
                if (!newStat || !Number.isFinite(newStat.mean)) continue;

                const oldStat = this.model.stats[label]?.[featureName];
                if (!oldStat) continue;

                const variance = Math.max(oldStat.var, 1e-9);
                const div = Math.abs(newStat.mean - oldStat.mean) / Math.sqrt(variance);
                divergences.push(div);
            }

            if (divergences.length === 0) continue;

            // Median divergence for robustness
            divergences.sort((a, b) => a - b);
            const median = divergences[Math.floor(divergences.length / 2)];
            perClass[label] = { medianDivergence: median, featureCount: divergences.length };

            if (median > maxDivergence) {
                maxDivergence = median;
                worstClass = label;
            }
        }

        if (!worstClass) return null;

        // Map divergence to suggested lambda
        let lambda, explanation;
        if (maxDivergence < 0.5) {
            lambda = 0.95;
            explanation = 'Drift mínimo';
        } else if (maxDivergence < 1.0) {
            lambda = 0.85;
            explanation = 'Drift moderado';
        } else if (maxDivergence < 2.0) {
            lambda = 0.70;
            explanation = 'Drift significativo';
        } else if (maxDivergence < 3.0) {
            lambda = 0.55;
            explanation = 'Drift severo';
        } else {
            lambda = 0.50;
            explanation = 'Drift extremo';
        }

        return {
            lambda,
            divergence: maxDivergence,
            explanation: `${explanation} em ${worstClass}`,
            worstClass,
            perClass,
        };
    }

    getInfo() {
        if (!this.isLoaded) return null;
        return {
            type: this.model.type,
            version: this.model.version,
            features: this.model.features,
            labels: this.model.labels,
            accuracy: this.model.metrics?.train_accuracy
        };
    }

    /**
     * Bayesian Online Update: merge new per-class feature stats into the loaded model.
     *
     * @param {object} sessionStats - { className: { featureName: { n, mean, std } } }
     *        std is SAMPLE std (ddof=1) as produced by the soak test summarizeNumeric().
     * @param {number} lambda - Forgetting factor [0,1]. Scales n_old before merge.
     *        lambda=1.0: no forgetting (pure Bayesian). lambda=0.5: new data counts ~2x.
     * @returns {object} delta - { className: { featureName: { mean_before, mean_after,
     *        var_before, var_after, count_before, count_after } } }
     */
    bayesianUpdate(sessionStats, lambda = 0.9) {
        if (!this.isLoaded || !this.model) {
            throw new Error('Model not loaded');
        }
        if (this.model.type !== 'gaussian_nb') {
            throw new Error('Bayesian update only supported for gaussian_nb models');
        }

        const delta = {};
        const labels = this.model.labels;

        for (const label of labels) {
            delta[label] = {};
            const classNewStats = sessionStats[label];
            if (!classNewStats) continue;

            for (const featureName of this.model.features) {
                const newStat = classNewStats[featureName];
                if (!newStat || !Number.isFinite(newStat.n) || newStat.n < 2) continue;
                if (!Number.isFinite(newStat.mean) || !Number.isFinite(newStat.std)) continue;

                const oldStat = this.model.stats[label][featureName];
                if (!oldStat) continue;

                const n_old_raw = oldStat.count || 50;
                const mean_old = oldStat.mean;
                const var_old = oldStat.var;

                // Apply forgetting factor
                const n_old = n_old_raw * lambda;

                const n_new = newStat.n;
                // Convert sample std (ddof=1) to population variance (ddof=0)
                const var_new = (newStat.std ** 2) * (n_new - 1) / n_new;
                const mean_new = newStat.mean;

                // Bayesian merge (population variance, matching sklearn GNB)
                const n_total = n_old + n_new;
                const mean_total = (n_old * mean_old + n_new * mean_new) / n_total;
                const var_total = (
                    n_old * (var_old + mean_old ** 2) +
                    n_new * (var_new + mean_new ** 2)
                ) / n_total - mean_total ** 2;

                // Record delta for UI
                delta[label][featureName] = {
                    mean_before: mean_old,
                    mean_after: mean_total,
                    var_before: var_old,
                    var_after: Math.max(var_total, 1e-12),
                    count_before: n_old_raw,
                    count_after: Math.round(n_total),
                };

                // Apply update in-place
                oldStat.mean = mean_total;
                oldStat.var = Math.max(var_total, 1e-12);
                oldStat.count = Math.round(n_total);
            }
        }

        // Update priors: blend old priors with session class proportions
        let totalSessionN = 0;
        const sessionN = {};
        for (const label of labels) {
            const cs = sessionStats[label];
            if (!cs) { sessionN[label] = 0; continue; }
            const firstFeat = Object.values(cs).find(s => s && Number.isFinite(s.n));
            sessionN[label] = firstFeat ? firstFeat.n : 0;
            totalSessionN += sessionN[label];
        }
        if (totalSessionN > 0) {
            for (const label of labels) {
                const oldPrior = this.model.priors[label] || (1 / labels.length);
                const newPrior = sessionN[label] / totalSessionN;
                this.model.priors[label] = lambda * oldPrior + (1 - lambda) * newPrior;
            }
            const sumPriors = labels.reduce((s, l) => s + this.model.priors[l], 0);
            for (const label of labels) {
                this.model.priors[label] /= sumPriors;
            }
        }

        return delta;
    }

    /**
     * Returns a deep copy of the current model object for serialization.
     */
    exportModel() {
        if (!this.isLoaded) return null;
        return JSON.parse(JSON.stringify(this.model));
    }
}

// =============================================================================
// SOFTMAX LOGISTIC REGRESSION CLASSIFIER (OPTIONAL)
// Expects JSON exported by notebook 03 (type: softmax_logreg)
// =============================================================================

class SoftmaxLogRegClassifier {
    constructor() {
        this.model = null;
        this.isLoaded = false;
    }

    async load(modelData) {
        try {
            let model = typeof modelData === 'string'
                ? await (await fetch(modelData)).json()
                : modelData;

            if (!model || typeof model !== 'object') {
                throw new Error('Invalid model payload');
            }

            if (!model.features || !model.labels || !model.scaler || !model.weights) {
                throw new Error('Model missing required fields (features/labels/scaler/weights)');
            }

            const mean = model.scaler?.mean;
            const scale = model.scaler?.scale;
            const coef = model.weights?.coef;
            const intercept = model.weights?.intercept;

            if (!Array.isArray(mean) || !Array.isArray(scale) || !Array.isArray(coef) || !Array.isArray(intercept)) {
                throw new Error('Model scaler/weights not in expected format');
            }

            this.model = model;
            this.isLoaded = true;
            console.log(`[Classifier] SoftmaxLogReg model v${model.version} loaded: ${model.labels.length} classes, ${model.features.length} features`);
            console.log(`[Classifier] Classes: ${model.labels.join(', ')}`);
            return true;
        } catch (error) {
            console.error('[Classifier] SoftmaxLogReg load failed:', error);
            this.isLoaded = false;
            return false;
        }
    }

    _softmax(logits) {
        const maxLogit = Math.max(...logits);
        const exps = logits.map(v => Math.exp(v - maxLogit));
        const sum = exps.reduce((a, b) => a + b, 0) || 1;
        return exps.map(v => v / sum);
    }

    predict(features) {
        if (!this.isLoaded) {
            return {
                prediction: 'UNKNOWN',
                confidence: 0,
                probabilities: {},
                error: 'Model not loaded'
            };
        }

        const model = this.model;
        const featNames = model.features || [];
        const labels = model.labels || [];
        const mean = model.scaler?.mean || [];
        const scale = model.scaler?.scale || [];
        const coef = model.weights?.coef || [];
        const intercept = model.weights?.intercept || [];

        // Build scaled feature vector
        const x = new Array(featNames.length);
        for (let j = 0; j < featNames.length; j++) {
            const fname = featNames[j];
            const v = features[fname];
            const raw = (v === undefined || v === null || Number.isNaN(v)) ? 0 : Number(v);
            const m = Number(mean[j] ?? 0);
            const s = Number(scale[j] ?? 1);
            x[j] = s > 1e-12 ? (raw - m) / s : (raw - m);
        }

        // logits = W x + b
        const logits = new Array(labels.length).fill(0);
        for (let i = 0; i < labels.length; i++) {
            let v = Number(intercept[i] ?? 0);
            const row = coef[i] || [];
            for (let j = 0; j < x.length; j++) {
                v += Number(row[j] ?? 0) * x[j];
            }
            logits[i] = v;
        }

        const probsArr = this._softmax(logits);
        const probabilities = {};
        let maxProb = probsArr[0] ?? 0;
        let bestIdx = 0;
        for (let i = 0; i < labels.length; i++) {
            const p = probsArr[i] ?? 0;
            probabilities[labels[i]] = p;
            if (p > maxProb) {
                maxProb = p;
                bestIdx = i;
            }
        }

        return {
            prediction: labels[bestIdx] || 'UNKNOWN',
            confidence: maxProb,
            probabilities
        };
    }

    getInfo() {
        if (!this.isLoaded) return null;
        return {
            type: this.model.type,
            version: this.model.version,
            features: this.model.features,
            labels: this.model.labels,
            accuracy: this.model.metrics?.train_accuracy
        };
    }
}

// =============================================================================
// RANDOM FOREST CLASSIFIER
// Expects JSON exported by notebook 03 (type: random_forest)
// Cada arvore e serializada como arrays planos: feature, threshold, children_left/right, value
// =============================================================================

class RandomForestClassifier {
    constructor() {
        this.model = null;
        this.isLoaded = false;
    }

    async load(modelData) {
        try {
            let model = typeof modelData === 'string'
                ? await (await fetch(modelData)).json()
                : modelData;

            if (!model || typeof model !== 'object') {
                throw new Error('Invalid model payload');
            }

            if (!model.features || !model.labels || !Array.isArray(model.trees) || model.trees.length === 0) {
                throw new Error('Model missing required fields (features/labels/trees)');
            }

            this.model = model;
            this.isLoaded = true;
            console.log(`[Classifier] RandomForest model v${model.version} loaded: ${model.labels.length} classes, ${model.features.length} features, ${model.trees.length} trees`);
            console.log(`[Classifier] Classes: ${model.labels.join(', ')}`);
            return true;
        } catch (error) {
            console.error('[Classifier] RandomForest load failed:', error);
            this.isLoaded = false;
            return false;
        }
    }

    /**
     * Percorre uma arvore de decisao usando arrays planos (formato sklearn serializado).
     * Folha identificada por children_left[node] === -1.
     * @returns {number} indice da classe predita (argmax dos counts na folha)
     */
    _predictTree(tree, x) {
        const feat   = tree.feature;
        const thr    = tree.threshold;
        const left   = tree.children_left;
        const right  = tree.children_right;
        const value  = tree.value;

        let node = 0;
        while (left[node] !== -1) {
            node = x[feat[node]] <= thr[node] ? left[node] : right[node];
        }

        // Argmax dos counts na folha
        const vals = value[node];
        let bestIdx = 0;
        for (let i = 1; i < vals.length; i++) {
            if (vals[i] > vals[bestIdx]) bestIdx = i;
        }
        return bestIdx;
    }

    predict(features) {
        if (!this.isLoaded) {
            return { prediction: 'UNKNOWN', confidence: 0, probabilities: {}, error: 'Model not loaded' };
        }

        const model = this.model;
        const featNames = model.features;
        const labels = model.labels;

        // Vetor de features (missing = 0)
        const x = new Array(featNames.length);
        for (let j = 0; j < featNames.length; j++) {
            const v = features[featNames[j]];
            x[j] = (v === undefined || v === null || Number.isNaN(v)) ? 0 : Number(v);
        }

        // Votacao entre todas as arvores
        const votes = new Int32Array(labels.length);
        for (const tree of model.trees) {
            votes[this._predictTree(tree, x)]++;
        }

        // Probabilidades = votos / n_trees
        const nTrees = model.trees.length;
        const probabilities = {};
        let bestIdx = 0;
        for (let i = 0; i < labels.length; i++) {
            probabilities[labels[i]] = votes[i] / nTrees;
            if (votes[i] > votes[bestIdx]) bestIdx = i;
        }

        return {
            prediction: labels[bestIdx],
            confidence: votes[bestIdx] / nTrees,
            probabilities
        };
    }

    getInfo() {
        if (!this.isLoaded) return null;
        return {
            type: this.model.type,
            version: this.model.version,
            features: this.model.features,
            labels: this.model.labels,
            accuracy: this.model.metrics?.cv_accuracy_mean,
            n_estimators: this.model.n_estimators,
        };
    }
}

// =============================================================================
// REAL-TIME CLASSIFIER
// =============================================================================

class RealTimeClassifier {
    constructor() {
        this.buffer = new CircularBuffer();
        this.classifier = new GaussianNBClassifier();
        this.lastPrediction = null;
        this.predictionHistory = [];
        this.maxHistory = 50;
        this.onPrediction = null;
        this.smoothedConfidence = {};
        this.feedCount = 0;

        // Hysteresis
        this.confirmedState = null;
        this.candidateState = null;
        this.candidateCount = 0;
        this.featureModeUntil = 0;
        this.lastFlushTime = 0;     // cooldown para change detection

        // Transition tracking
        this.transitionStartTime = null;   // quando candidato começou a divergir
        this.transitionLog = [];           // últimas N transições
        this.maxTransitionLog = 20;
        this.onTransition = null;          // callback para dashboard
    }

    async init(modelData) {
        // Load JSON first so we can pick the right classifier implementation.
        let modelObj = modelData;
        try {
            if (typeof modelData === 'string') {
                modelObj = await (await fetch(modelData)).json();
            }
        } catch (e) {
            console.error('[RealTimeClassifier] Failed to fetch model JSON:', e);
        }

        const type = (modelObj && typeof modelObj === 'object' && typeof modelObj.type === 'string')
            ? modelObj.type
            : '';

        if (type === 'softmax_logreg') {
            this.classifier = new SoftmaxLogRegClassifier();
        } else if (type === 'random_forest') {
            this.classifier = new RandomForestClassifier();
        } else {
            this.classifier = new GaussianNBClassifier();
        }

        const success = await this.classifier.load(modelObj);
        if (success) {
            // Initialize smoothed confidence based on model labels
            const labels = this.classifier.model.labels;
            this.smoothedConfidence = {};
            for (const label of labels) {
                this.smoothedConfidence[label] = 1 / labels.length;
            }
            console.log(`[RealTimeClassifier] v6.0 initialized - ${labels.length} classes`);
        }
        return success;
    }

    addData(data) {
        this.buffer.push(data);
        this.feedCount++;
        this._detectAbruptChange();
    }

    /**
     * Detecta mudança brusca comparando P95 dos últimos N pontos vs primeira metade do buffer.
     * Usa P95(|gz|) em vez de média para alinhar com a feature peak do modelo.
     */
    _detectAbruptChange() {
        const cfg = ClassifierConfig;
        if (this.buffer.size < cfg.MIN_POINTS) return;

        // Cooldown: não fazer flush se fez um recentemente
        const now = Date.now();
        if (now - this.lastFlushTime < cfg.CHANGE_DETECT_COOLDOWN) return;

        const arrays = this.buffer.getArrays();
        const gz = arrays.gz;
        const n = gz.length;
        const recentN = cfg.CHANGE_DETECT_WINDOW;
        if (n < recentN * 2) return;

        // P95 dos valores absolutos: primeira metade vs últimos N pontos
        const oldAbs = [];
        for (let i = 0; i < n - recentN; i++) oldAbs.push(Math.abs(gz[i]));
        const recentAbs = [];
        for (let i = n - recentN; i < n; i++) recentAbs.push(Math.abs(gz[i]));

        oldAbs.sort((a, b) => a - b);
        recentAbs.sort((a, b) => a - b);

        const p95Old = oldAbs[Math.floor(0.95 * (oldAbs.length - 1))];
        const p95Recent = recentAbs[Math.floor(0.95 * (recentAbs.length - 1))];

        if (p95Old > 1) {
            const ratio = p95Recent / p95Old;
            if (ratio < cfg.CHANGE_DETECT_RATIO || ratio > (1 / cfg.CHANGE_DETECT_RATIO)) {
                console.log(`[ChangeDetect] Mudança brusca: ratio=${ratio.toFixed(2)} (P95 recent=${p95Recent.toFixed(1)} vs old=${p95Old.toFixed(1)}). Flush.`);
                this._fastFlush();
                this.lastFlushTime = now;
            }
        }
    }

    /**
     * Flush parcial: mantém apenas os últimos N pontos, resetando suavização e histerese.
     */
    _fastFlush() {
        const keep = ClassifierConfig.FAST_FLUSH_KEEP;
        const arrays = this.buffer.getArrays();
        const n = this.buffer.size;
        if (n <= keep) return;

        // Rebuild buffer with only recent points
        this.buffer.clear();
        for (let i = n - keep; i < n; i++) {
            this.buffer.push({
                ax: arrays.ax[i], ay: arrays.ay[i], az: arrays.az[i],
                gx: arrays.gx[i], gy: arrays.gy[i], gz: arrays.gz[i],
                vib: arrays.vib[i], timestamp: Date.now()
            });
        }

        // Reset smoothing to uniform (fresh start)
        const labels = this.classifier.model?.labels || ClassLabels.ORDER;
        for (const label of labels) {
            this.smoothedConfidence[label] = 1 / labels.length;
        }

        // Reset hysteresis
        this.confirmedState = null;
        this.candidateState = null;
        this.candidateCount = 0;
    }

    _isAdjacentTransition(fromLabel, toLabel) {
        if (!fromLabel || !toLabel || fromLabel === toLabel) return false;
        const order = this.classifier?.model?.labels || ClassLabels.ORDER;
        const idxFrom = order.indexOf(fromLabel);
        const idxTo = order.indexOf(toLabel);
        if (idxFrom < 0 || idxTo < 0) return false;
        return Math.abs(idxFrom - idxTo) === 1;
    }

    markFeatureMode(ttlMs = 3000) {
        this.featureModeUntil = Date.now() + ttlMs;
    }

    isFeatureModeActive() {
        return Date.now() < this.featureModeUntil;
    }

    clearFeatureMode() {
        this.featureModeUntil = 0;
    }

    _applyResult(result, features, bufferSizeOverride = null) {
        const labels = this.classifier.model.labels;

        // Suavização Exponencial: A nova confiança é uma média da atual com a anterior
        const alpha = ClassifierConfig.SMOOTHING_ALPHA;
        for (const label of labels) {
            const prob = result.probabilities[label] || 0;
            this.smoothedConfidence[label] = alpha * prob + (1 - alpha) * this.smoothedConfidence[label];
        }

        // Normalize
        const total = Object.values(this.smoothedConfidence).reduce((a, b) => a + b, 0);
        for (const label of labels) {
            this.smoothedConfidence[label] /= total;
        }

        // Find best smoothed prediction
        let rawSmoothedPrediction = labels[0];
        let smoothedConfValue = this.smoothedConfidence[labels[0]];

        for (const label of labels) {
            if (this.smoothedConfidence[label] > smoothedConfValue) {
                smoothedConfValue = this.smoothedConfidence[label];
                rawSmoothedPrediction = label;
            }
        }

        const sortedProbs = labels
            .map(label => ({ label, prob: this.smoothedConfidence[label] || 0 }))
            .sort((a, b) => b.prob - a.prob);
        const top1 = sortedProbs[0] || { label: rawSmoothedPrediction, prob: smoothedConfValue };
        const top2 = sortedProbs[1] || { label: null, prob: 0 };
        const confidenceGap = top1.prob - top2.prob;

        const isAdjacentTransition = this._isAdjacentTransition(this.confirmedState, top1.label);
        const effectiveConfidenceGate = isAdjacentTransition
            ? ClassifierConfig.ADJACENT_TRANSITION_CONFIDENCE_GATE
            : ClassifierConfig.CONFIDENCE_GATE;
        const effectiveConfidenceMargin = isAdjacentTransition
            ? ClassifierConfig.ADJACENT_TRANSITION_CONFIDENCE_MARGIN
            : ClassifierConfig.CONFIDENCE_MARGIN;
        const effectiveHysteresisCount = isAdjacentTransition
            ? ClassifierConfig.ADJACENT_TRANSITION_HYSTERESIS_COUNT
            : ClassifierConfig.HYSTERESIS_COUNT;

        const confidenceOk = top1.prob >= effectiveConfidenceGate &&
            confidenceGap >= effectiveConfidenceMargin;

        // Aplica HISTERESE: Só muda o estado se a nova predição se mantiver por N vezes
        let finalPrediction;
        const previousConfirmed = this.confirmedState;

        if (!confidenceOk) {
            if (this.confirmedState === null) {
                this.confirmedState = rawSmoothedPrediction;
                this.candidateState = rawSmoothedPrediction;
                this.candidateCount = 0;
                this.transitionStartTime = null;
            } else {
                // Exige predicoes confiantes e consecutivas. Se cair a confianca, reinicia a transicao pendente.
                this.candidateState = this.confirmedState;
                this.candidateCount = 0;
                this.transitionStartTime = null;
            }
            finalPrediction = this.confirmedState;
        } else {
            if (this.confirmedState === null) {
                this.confirmedState = rawSmoothedPrediction;
                this.candidateState = rawSmoothedPrediction;
                this.candidateCount = effectiveHysteresisCount;
                finalPrediction = rawSmoothedPrediction;
            } else if (rawSmoothedPrediction === this.confirmedState) {
                this.candidateState = rawSmoothedPrediction;
                this.candidateCount = 0;
                this.transitionStartTime = null; // estável, sem transição pendente
                finalPrediction = this.confirmedState;
            } else if (rawSmoothedPrediction === this.candidateState) {
                // Marcar início da transição
                if (this.transitionStartTime === null) {
                    this.transitionStartTime = Date.now();
                }
                this.candidateCount++;
                if (this.candidateCount >= effectiveHysteresisCount) {
                    this.confirmedState = this.candidateState;
                    finalPrediction = this.confirmedState;
                    console.log(`[Hysteresis] State confirmed: ${this.confirmedState}`);
                } else {
                    finalPrediction = this.confirmedState;
                }
            } else {
                this.candidateState = rawSmoothedPrediction;
                this.candidateCount = 1;
                this.transitionStartTime = Date.now();
                finalPrediction = this.confirmedState;
            }
        }

        // Registrar transição quando estado confirmado muda
        if (previousConfirmed !== null && this.confirmedState !== previousConfirmed) {
            const transitionMs = this.transitionStartTime
                ? Date.now() - this.transitionStartTime
                : 0;
            const entry = {
                from: previousConfirmed,
                to: this.confirmedState,
                duration_ms: transitionMs,
                duration_s: +(transitionMs / 1000).toFixed(1),
                timestamp: Date.now(),
                time: new Date().toLocaleTimeString('pt-BR'),
                confidence: smoothedConfValue,
                confidence_gap: confidenceGap,
                confidence_gate: effectiveConfidenceGate,
                confidence_margin: effectiveConfidenceMargin,
                hysteresis_count: effectiveHysteresisCount,
                bufferSize: bufferSizeOverride ?? this.buffer.size,
                featureAgreement: this._calcFeatureAgreement(features),
            };
            this.transitionLog.push(entry);
            while (this.transitionLog.length > this.maxTransitionLog) {
                this.transitionLog.shift();
            }
            this.transitionStartTime = null;
            console.log(`[Transition] ${entry.from} -> ${entry.to} em ${entry.duration_s}s (concordancia: ${entry.featureAgreement.ratio})`);

            if (this.onTransition) {
                this.onTransition(entry);
            }
        }

        // Confidence level
        let confidenceLevel;
        if (smoothedConfValue >= ClassifierConfig.CONFIDENCE_HIGH) {
            confidenceLevel = 'high';
        } else if (smoothedConfValue >= ClassifierConfig.CONFIDENCE_MEDIUM) {
            confidenceLevel = 'medium';
        } else {
            confidenceLevel = 'low';
        }

        const prediction = {
            status: 'ok',
            prediction: finalPrediction,
            rawPrediction: result.prediction,
            confidence: smoothedConfValue,
            rawConfidence: result.confidence,
            confidenceLevel,
            confidenceGap,
            gateActive: !confidenceOk,
            effectiveConfidenceGate,
            effectiveConfidenceMargin,
            probabilities: result.probabilities,
            smoothedProbabilities: { ...this.smoothedConfidence },
            bufferSize: bufferSizeOverride ?? this.buffer.size,
            timestamp: Date.now(),
            features,
            confirmedState: this.confirmedState,
            candidateState: this.candidateState,
            candidateCount: this.candidateCount,
            hysteresisCount: effectiveHysteresisCount,
            featureAgreement: this._calcFeatureAgreement(features),
            transitionPending: this.transitionStartTime !== null,
            transitionElapsed: this.transitionStartTime ? Date.now() - this.transitionStartTime : 0,
        };

        this.lastPrediction = prediction;
        this.predictionHistory.push({
            timestamp: prediction.timestamp,
            prediction: prediction.prediction,
            confidence: prediction.confidence
        });

        while (this.predictionHistory.length > this.maxHistory) {
            this.predictionHistory.shift();
        }

        if (this.onPrediction) {
            this.onPrediction(prediction);
        }

        return prediction;
    }

    predictWithFeatures(features, windowSize = null) {
        if (!this.classifier.isLoaded) {
            return {
                status: 'error',
                message: 'Model not loaded',
                prediction: 'UNKNOWN',
                confidence: 0
            };
        }

        if (!features) {
            return {
                status: 'error',
                message: 'Features missing',
                prediction: 'UNKNOWN',
                confidence: 0
            };
        }

        const result = this.classifier.predict(features);
        this.markFeatureMode();
        return this._applyResult(result, features, windowSize);
    }

    predict() {
        if (!this.classifier.isLoaded) {
            return {
                status: 'error',
                message: 'Model not loaded',
                prediction: 'UNKNOWN',
                confidence: 0
            };
        }

        if (!this.buffer.isReady) {
            const progress = this.buffer.size / ClassifierConfig.MIN_POINTS;
            return {
                status: 'buffering',
                message: `Coletando: ${this.buffer.size}/${ClassifierConfig.MIN_POINTS}`,
                prediction: 'BUFFERING',
                confidence: 0,
                bufferProgress: progress
            };
        }

        // Extract temporal features
        const data = this.buffer.getArrays();
        const featureList = this.classifier.model?.features || null;
        const samplingHz = this.classifier.model?.sampling_hz || ClassifierConfig.SAMPLING_HZ;
        const features = FeatureExtractor.extract(data, featureList, samplingHz);

        // Run classification
        const result = this.classifier.predict(features);
        return this._applyResult(result, features, this.buffer.size);
    }

    /**
     * Calcula quantas features apontam para cada classe (por proximidade z-score)
     */
    _calcFeatureAgreement(features) {
        if (!this.classifier.model || !features) return { ratio: '--', counts: {} };
        const model = this.classifier.model;
        // Only available for GaussianNB models (needs per-class mean/var stats).
        if (!model.stats || !model.labels) return { ratio: '--', counts: {} };
        const counts = {};
        for (const label of model.labels) counts[label] = 0;
        let total = 0;

        for (const fname of model.features) {
            const v = features[fname];
            if (v === undefined || v === null) continue;
            let bestLabel = null;
            let bestZ = Infinity;
            for (const label of model.labels) {
                const s = model.stats[label]?.[fname];
                if (!s) continue;
                const std = Math.sqrt(Math.max(s.var, 1e-3));
                const z = Math.abs(v - s.mean) / std;
                if (z < bestZ) { bestZ = z; bestLabel = label; }
            }
            if (bestLabel) { counts[bestLabel]++; total++; }
        }

        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        return {
            counts,
            best: best ? best[0] : '--',
            bestCount: best ? best[1] : 0,
            total,
            ratio: best ? `${best[1]}/${total} -> ${best[0]}` : '--',
        };
    }

    getTransitionLog() {
        return this.transitionLog;
    }

    getStability() {
        if (this.predictionHistory.length < 5) return 0;
        const recent = this.predictionHistory.slice(-10);
        const counts = {};
        for (const p of recent) {
            counts[p.prediction] = (counts[p.prediction] || 0) + 1;
        }
        return Math.max(...Object.values(counts)) / recent.length;
    }

    getModelInfo() {
        return this.classifier.getInfo();
    }

    getStats() {
        return {
            bufferSize: this.buffer.size,
            feedCount: this.feedCount,
            predictionCount: this.predictionHistory.length,
            stability: this.getStability()
        };
    }

    /**
     * Apply Bayesian update to the inner classifier model.
     * @param {object} sessionStats - { className: { featureName: { n, mean, std } } }
     * @param {number} lambda - Forgetting factor (0-1)
     * @returns {object} delta
     */
    bayesianUpdate(sessionStats, lambda = 0.9) {
        if (!(this.classifier instanceof GaussianNBClassifier)) {
            throw new Error('Bayesian update only available for GaussianNB classifier');
        }
        return this.classifier.bayesianUpdate(sessionStats, lambda);
    }

    /**
     * Export current model as JSON-serializable object.
     */
    exportModel() {
        if (!(this.classifier instanceof GaussianNBClassifier)) return null;
        return this.classifier.exportModel();
    }

    /**
     * Compute drift z-scores for current features against the model.
     */
    computeDrift(features) {
        if (!(this.classifier instanceof GaussianNBClassifier)) return null;
        return this.classifier.computeDrift(features);
    }

    /**
     * Suggest lambda value based on divergence between session stats and model.
     */
    computeSuggestedLambda(sessionStats) {
        if (!(this.classifier instanceof GaussianNBClassifier)) return null;
        return this.classifier.computeSuggestedLambda(sessionStats);
    }

    /**
     * Replace the inner model with a previously exported one (e.g. from localStorage).
     * @param {object} modelObj - Full model JSON object
     */
    async loadAdaptedModel(modelObj) {
        const success = await this.classifier.load(modelObj);
        if (success) {
            this.reset();
        }
        return success;
    }

    reset() {
        this.buffer.clear();
        this.lastPrediction = null;
        this.predictionHistory = [];
        this.feedCount = 0;

        // Reset smoothed confidence
        const labels = this.classifier.model?.labels || ClassLabels.ORDER;
        this.smoothedConfidence = {};
        for (const label of labels) {
            this.smoothedConfidence[label] = 1 / labels.length;
        }

        // Reset hysteresis
        this.confirmedState = null;
        this.candidateState = null;
        this.candidateCount = 0;
        this.featureModeUntil = 0;
    }

    get isReady() {
        return this.classifier.isLoaded;
    }
}

// =============================================================================
// EXPORTS
// =============================================================================

window.ClassifierConfig = ClassifierConfig;
window.CircularBuffer = CircularBuffer;
window.Stats = Stats;
window.FeatureExtractor = FeatureExtractor;
window.GaussianNBClassifier = GaussianNBClassifier;
window.SoftmaxLogRegClassifier = SoftmaxLogRegClassifier;
window.RandomForestClassifier = RandomForestClassifier;
window.RealTimeClassifier = RealTimeClassifier;
window.SlidingWindowBuffer = CircularBuffer; // Legacy

window.fanClassifier = new RealTimeClassifier();

console.log('[Classifier] v6.1 loaded - RF + GNB + percentiles + FFT bands');
