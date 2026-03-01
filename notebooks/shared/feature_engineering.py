import numpy as np
from scipy.stats import skew, kurtosis
from scipy.fft import rfft, rfftfreq
from scipy.signal import detrend as scipy_detrend, windows as scipy_windows


# ---------------------------------------------------------------------------
# Spectral band definitions (calibration targets — update after first EDA)
# ---------------------------------------------------------------------------
# Bands are ESTIMATES based on typical fan physics.
# Run 04_Spectral_Feature_Analysis.ipynb after first 100 Hz collection to
# identify the exact peak Hz for each class and update these limits.
SPECTRAL_BANDS = {
    'rot':      (0.50,  1.80),   # rotação: LOW pico ~1.465 Hz, ROT_ON ~1.074 Hz
    'low_spd':  (1.00,  2.00),   # LOW speed vibration (~1.465 Hz)
    'med_spd':  (2.00,  3.50),   # MEDIUM speed vibration (~2.2 Hz)
    'high_spd': (3.50,  7.00),   # HIGH speed vibration (~3.9–5.3 Hz)
    'hi_freq':  (7.00, 25.00),   # altas freq — gyro MEDIUM/HIGH (~9–27 Hz)
    'noise':   (25.00, 50.00),   # noise floor (referência)
}
# Bandas calibradas em 23/02/2026 com coleta col_20260223_115149_100hz @ 100 Hz
# Picos observados (accel_x_g): LOW=1.465, MEDIUM=2.197-2.246, HIGH=3.931-5.322 Hz
# Picos observados (gyro_z_dps): ROT_ON magnitude 3× maior que ROT_OFF na banda rot


def compute_time_features(values, axis_name, ddof=0):
    """Calcula 11 metricas estatisticas para uma janela de dados.

    ddof=0 por padrao para alinhar com o JS.
    """
    arr = np.asarray(values, dtype=np.float64)
    n = len(arr)
    if n == 0:
        return {}

    mean_val = np.mean(arr)
    std_val = np.std(arr, ddof=ddof)
    skew_val = float(skew(arr, bias=True))
    kurt_val = float(kurtosis(arr, fisher=True, bias=True))
    rms_val = np.sqrt(np.mean(arr ** 2))
    peak_val = np.max(np.abs(arr))
    root_amplitude = (np.mean(np.sqrt(np.abs(arr)))) ** 2
    mean_abs = np.mean(np.abs(arr))

    crest_factor = peak_val / rms_val if rms_val > 1e-10 else 0.0
    shape_factor = rms_val / mean_abs if mean_abs > 1e-10 else 0.0
    impulse_factor = peak_val / mean_abs if mean_abs > 1e-10 else 0.0
    clearance_factor = peak_val / root_amplitude if root_amplitude > 1e-10 else 0.0

    return {
        f'{axis_name}_mean': mean_val,
        f'{axis_name}_std': std_val,
        f'{axis_name}_skew': skew_val,
        f'{axis_name}_kurtosis': kurt_val,
        f'{axis_name}_rms': rms_val,
        f'{axis_name}_peak': peak_val,
        f'{axis_name}_root_amplitude': root_amplitude,
        f'{axis_name}_crest_factor': crest_factor,
        f'{axis_name}_shape_factor': shape_factor,
        f'{axis_name}_impulse_factor': impulse_factor,
        f'{axis_name}_clearance_factor': clearance_factor,
    }


def compute_basic_features(values, axis_name, ddof=0):
    """Calcula apenas std, range e rms para uma janela.

    Alinhado com o modelo atual (6 features) e JS (ddof=0).
    """
    arr = np.asarray(values, dtype=np.float64)
    if arr.size == 0:
        return {}
    std_val = float(np.std(arr, ddof=ddof))
    rms_val = float(np.sqrt(np.mean(arr ** 2)))
    range_val = float(np.max(arr) - np.min(arr))
    return {
        f'{axis_name}_std': std_val,
        f'{axis_name}_range': range_val,
        f'{axis_name}_rms': rms_val,
    }


def extract_features_windowed(df_class, fan_state, sensor_axes, window_size, step_size, timestamp_col='timestamp_s'):
    """Extrai features por janela deslizante para uma classe, incluindo timestamps."""
    rows = []
    n = len(df_class)
    if n < window_size or window_size <= 0 or step_size <= 0:
        return rows

    for start in range(0, n - window_size + 1, step_size):
        end = start + window_size
        window_df = df_class.iloc[start:end]
        ts_mean = window_df[timestamp_col].mean() if timestamp_col in window_df.columns else None
        ts_start = window_df[timestamp_col].iloc[0] if timestamp_col in window_df.columns else None
        ts_end = window_df[timestamp_col].iloc[-1] if timestamp_col in window_df.columns else None
        # Group id for GroupKFold and end-to-end traceability.
        col_id = None
        if 'collection_id' in window_df.columns:
            try:
                col_id = window_df['collection_id'].mode().iloc[0]
            except Exception:
                try:
                    col_id = window_df['collection_id'].iloc[0]
                except Exception:
                    col_id = None

        feat = {
            'fan_state': fan_state,
            'collection_id': col_id,
            'window_start': start,
            'window_end': end,
            'timestamp_start': ts_start,
            'timestamp_end': ts_end,
            'timestamp_mean': ts_mean,
        }

        for axis in sensor_axes:
            feat.update(compute_time_features(window_df[axis].values, axis, ddof=0))

        rows.append(feat)

    return rows


def extract_features_windowed_basic(df_class, fan_state, sensor_axes, window_size, step_size, timestamp_col='timestamp_s'):
    """Extrai features basicas (std/range/rms) por janela deslizante."""
    rows = []
    n = len(df_class)
    if n < window_size or window_size <= 0 or step_size <= 0:
        return rows

    for start in range(0, n - window_size + 1, step_size):
        end = start + window_size
        window_df = df_class.iloc[start:end]
        ts_mean = window_df[timestamp_col].mean() if timestamp_col in window_df.columns else None
        ts_start = window_df[timestamp_col].iloc[0] if timestamp_col in window_df.columns else None
        ts_end = window_df[timestamp_col].iloc[-1] if timestamp_col in window_df.columns else None
        col_id = None
        if 'collection_id' in window_df.columns:
            try:
                col_id = window_df['collection_id'].mode().iloc[0]
            except Exception:
                try:
                    col_id = window_df['collection_id'].iloc[0]
                except Exception:
                    col_id = None

        feat = {
            'fan_state': fan_state,
            'collection_id': col_id,
            'window_start': start,
            'window_end': end,
            'timestamp_start': ts_start,
            'timestamp_end': ts_end,
            'timestamp_mean': ts_mean,
        }

        for axis in sensor_axes:
            feat.update(compute_basic_features(window_df[axis].values, axis, ddof=0))

        rows.append(feat)

    return rows


# ---------------------------------------------------------------------------
# Extended feature extraction (FFT bands + percentiles + shape stats)
# ---------------------------------------------------------------------------

def compute_extended_features(values, axis_name, sampling_hz=20.0, ddof=0):
    """Calcula features estendidas para uma janela: basicas + FFT + percentis + skew/kurtosis.

    Bands FFT (magnitude RMS de cada banda de frequencia):
      - low  : 0–5 Hz
      - mid  : 5–15 Hz
      - high : 15–(fs/2) Hz

    Percentis: P10, P25, P75, P90, P95
    Shape: skewness, kurtosis (excess)
    """
    arr = np.asarray(values, dtype=np.float64)
    n = len(arr)
    if n == 0:
        return {}

    feats = {}

    # -- Basic (std / range / rms) --
    feats[f'{axis_name}_std']   = float(np.std(arr, ddof=ddof))
    feats[f'{axis_name}_range'] = float(np.max(arr) - np.min(arr))
    feats[f'{axis_name}_rms']   = float(np.sqrt(np.mean(arr ** 2)))

    # -- Shape --
    feats[f'{axis_name}_skew']     = float(skew(arr, bias=True))
    feats[f'{axis_name}_kurtosis'] = float(kurtosis(arr, fisher=True, bias=True))

    # -- Percentiles --
    for pct in (10, 25, 75, 90, 95):
        feats[f'{axis_name}_p{pct}'] = float(np.percentile(arr, pct))

    # -- FFT energy bands --
    spectrum = np.abs(rfft(arr - arr.mean()))  # remove DC offset
    freqs = rfftfreq(n, d=1.0 / sampling_hz)

    def _band_rms(f_lo, f_hi):
        mask = (freqs >= f_lo) & (freqs < f_hi)
        if not mask.any():
            return 0.0
        return float(np.sqrt(np.mean(spectrum[mask] ** 2)))

    fs_half = sampling_hz / 2.0
    feats[f'{axis_name}_fft_low']  = _band_rms(0.0,  5.0)
    feats[f'{axis_name}_fft_mid']  = _band_rms(5.0,  15.0)
    feats[f'{axis_name}_fft_high'] = _band_rms(15.0, fs_half)

    return feats


def _extract_window_metadata(window_df, fan_state, timestamp_col):
    """Helper: devolve dict com metadados da janela (fan_state, collection_id, timestamps)."""
    ts_mean  = window_df[timestamp_col].mean() if timestamp_col in window_df.columns else None
    ts_start = window_df[timestamp_col].iloc[0] if timestamp_col in window_df.columns else None
    ts_end   = window_df[timestamp_col].iloc[-1] if timestamp_col in window_df.columns else None
    col_id   = None
    if 'collection_id' in window_df.columns:
        try:
            col_id = window_df['collection_id'].mode().iloc[0]
        except Exception:
            try:
                col_id = window_df['collection_id'].iloc[0]
            except Exception:
                col_id = None
    return {
        'fan_state':       fan_state,
        'collection_id':   col_id,
        'window_start':    window_df.index[0],
        'window_end':      window_df.index[-1],
        'timestamp_start': ts_start,
        'timestamp_end':   ts_end,
        'timestamp_mean':  ts_mean,
    }


def extract_features_windowed_extended(
    df_class, fan_state, sensor_axes, window_size, step_size,
    timestamp_col='timestamp_s', sampling_hz=20.0,
):
    """Extrai features estendidas (basicas + FFT + percentis + skew/kurtosis) por janela deslizante.

    Parametros
    ----------
    df_class     : DataFrame filtrado para uma classe/fan_state
    fan_state    : label da classe (str)
    sensor_axes  : lista de colunas a processar (ex: ['accel_x_g', 'gyro_y_dps', ...])
    window_size  : numero de amostras por janela
    step_size    : deslocamento entre janelas
    timestamp_col: coluna de timestamp em segundos
    sampling_hz  : taxa de amostragem real (usada nos calculos FFT)

    Retorna
    -------
    list[dict]: uma linha por janela com todas as features + metadados
    """
    rows = []
    n = len(df_class)
    if n < window_size or window_size <= 0 or step_size <= 0:
        return rows

    df_reset = df_class.reset_index(drop=True)
    for start in range(0, n - window_size + 1, step_size):
        end = start + window_size
        window_df = df_reset.iloc[start:end]
        feat = _extract_window_metadata(window_df, fan_state, timestamp_col)
        feat['window_start'] = start
        feat['window_end']   = end

        for axis in sensor_axes:
            feat.update(compute_extended_features(
                window_df[axis].values, axis,
                sampling_hz=sampling_hz, ddof=0,
            ))

        rows.append(feat)

    return rows


# ---------------------------------------------------------------------------
# Spectral signature — full spectrum for EDA visualization
# ---------------------------------------------------------------------------

def compute_spectral_signature(values, sampling_hz=100.0, n_fft=4096):
    """Full spectral pipeline for EDA: detrend → Hann → zero-pad → FFT.

    Returns
    -------
    freqs : ndarray   — frequency axis (Hz)
    mags  : ndarray   — amplitude spectrum (corrected for window)
    peak_freq : float — dominant frequency above 0.5 Hz
    peak_mag  : float — magnitude at peak_freq
    band_energies : dict — RMS energy per SPECTRAL_BANDS entry
    """
    arr = np.asarray(values, dtype=np.float64)
    n = len(arr)
    if n < 16:
        empty = np.zeros(n_fft // 2 + 1)
        return rfftfreq(n_fft, 1.0 / sampling_hz), empty, 0.0, 0.0, {}

    # 1. Remove linear drift (eliminates slow sensor tilt / gravity shift)
    arr = scipy_detrend(arr)

    # 2. Hann window (prevents spectral leakage at window edges)
    win = scipy_windows.hann(n)
    win_rms = float(np.sqrt(np.mean(win ** 2)))
    arr_w = arr * win

    # 3. FFT with zero-padding → finer bin spacing
    #    n_fft=4096, window=1000 @ 100 Hz → bins at 0.024 Hz
    spectrum = np.abs(rfft(arr_w, n=n_fft))
    freqs = rfftfreq(n_fft, d=1.0 / sampling_hz)

    # Amplitude correction: window RMS + one-sided spectrum
    mags = spectrum / (n * win_rms)
    mags[1:-1] *= 2.0

    # 4. Dominant peak above 0.5 Hz (avoid DC residue)
    mask_peak = freqs >= 0.5
    if mask_peak.any():
        idx = int(np.argmax(mags[mask_peak]))
        peak_freq = float(freqs[mask_peak][idx])
        peak_mag  = float(mags[mask_peak][idx])
    else:
        peak_freq, peak_mag = 0.0, 0.0

    # 5. Band energies (RMS of magnitudes inside each band)
    band_energies = {}
    for band_name, (f_lo, f_hi) in SPECTRAL_BANDS.items():
        mask = (freqs >= f_lo) & (freqs < f_hi)
        band_energies[band_name] = float(np.sqrt(np.mean(mags[mask] ** 2))) if mask.any() else 0.0

    return freqs, mags, peak_freq, peak_mag, band_energies


# ---------------------------------------------------------------------------
# Spectral features — ML-ready feature vector per window
# ---------------------------------------------------------------------------

def compute_spectral_features(values, axis_name, sampling_hz=100.0,
                               n_fft=4096, bands=None):
    """Spectral ML features for one axis window.

    Features per axis:
      {axis}_peak_freq              — dominant frequency (Hz)
      {axis}_peak_mag               — magnitude at dominant peak
      {axis}_band_{name}_energy     — RMS energy per band in SPECTRAL_BANDS

    Same detrend + Hann + zero-pad pipeline as compute_spectral_signature.
    """
    if bands is None:
        bands = SPECTRAL_BANDS

    _, mags, peak_freq, peak_mag, band_energies = compute_spectral_signature(
        values, sampling_hz=sampling_hz, n_fft=n_fft
    )

    feats = {
        f'{axis_name}_peak_freq': peak_freq,
        f'{axis_name}_peak_mag':  peak_mag,
    }
    for band_name, energy in band_energies.items():
        feats[f'{axis_name}_band_{band_name}_energy'] = energy

    return feats


# ---------------------------------------------------------------------------
# Windowed spectral feature extraction (notebooks / training pipeline)
# ---------------------------------------------------------------------------

def extract_features_windowed_spectral(
    df_class, fan_state, sensor_axes, window_size, step_size,
    timestamp_col='timestamp_s', sampling_hz=100.0, n_fft=4096,
):
    """Windowed spectral feature extraction (detrend + Hann + zero-pad).

    One row per window, spectral features for all sensor_axes.
    Compatible with extract_features_windowed_extended — can be concatenated.

    Parameters
    ----------
    window_size : samples per window
                  1000 = 10 s @ 100 Hz → true resolution Δf = 0.1 Hz
    step_size   : stride between windows
                  500 = 50% overlap → new analysis every 5 s
    n_fft       : FFT zero-padding size (4096 recommended)
    """
    rows = []
    n = len(df_class)
    if n < window_size or window_size <= 0 or step_size <= 0:
        return rows

    df_reset = df_class.reset_index(drop=True)
    for start in range(0, n - window_size + 1, step_size):
        end = start + window_size
        window_df = df_reset.iloc[start:end]
        feat = _extract_window_metadata(window_df, fan_state, timestamp_col)
        feat['window_start'] = start
        feat['window_end']   = end

        for axis in sensor_axes:
            feat.update(compute_spectral_features(
                window_df[axis].values, axis,
                sampling_hz=sampling_hz, n_fft=n_fft,
            ))

        # Auto-adiciona bandas finas para accel_mag_g se não veio em sensor_axes
        if 'accel_mag_g' not in sensor_axes:
            _comps = ('accel_x_g', 'accel_y_g', 'accel_z_g')
            if all(c in window_df.columns for c in _comps):
                _mag = np.sqrt(sum(window_df[c].values ** 2 for c in _comps))
                feat.update(compute_spectral_features(
                    _mag, 'accel_mag_g', sampling_hz=sampling_hz, n_fft=n_fft,
                ))

        rows.append(feat)

    return rows


# ---------------------------------------------------------------------------
# Drift-resistant features — amplitude-independent spectral descriptors
# ---------------------------------------------------------------------------
# Princípio: razões e frações cancelam o fator de escala global.
# Se a vibração dobrar por desgaste mecânico, todas as bandas dobram juntas
# e as razões permanecem constantes → robustez ao drift.
#
# Features produzidas por eixo:
#   {axis}_spectral_centroid   — frequência central ponderada por energia (Hz)
#   {axis}_spectral_spread     — dispersão em torno do centroide (Hz)
#   {axis}_spectral_flatness   — tonalidade: próximo de 0=ruído, 1=tom_puro
#   {axis}_band_{name}_frac    — fração de energia de cada banda / energia total
#   {axis}_hi_lo_ratio         — razão entre bandas de alta e baixa frequência
#   {axis}_top2_freq_ratio     — razão entre 2º e 1º pico dominante (harmonicidade)
# ---------------------------------------------------------------------------

def compute_drift_resistant_features(values, axis_name, sampling_hz=100.0,
                                     n_fft=4096, bands=None, eps=1e-12):
    """Features espectrais independentes de amplitude absoluta.

    Todas as features são razões ou frequências — resistentes ao drift mecânico.

    Parameters
    ----------
    values      : array-like — janela temporal de um eixo
    axis_name   : str — prefixo das features geradas
    sampling_hz : float — taxa de amostragem
    n_fft       : int — tamanho do FFT com zero-padding
    bands       : dict opcional — substitui SPECTRAL_BANDS
    eps         : float — evita divisão por zero

    Returns
    -------
    dict com features drift-resistant prefixadas por axis_name
    """
    if bands is None:
        bands = SPECTRAL_BANDS

    arr = np.asarray(values, dtype=np.float64)
    n = len(arr)
    if n < 16:
        feats = {}
        for bname in bands:
            feats[f'{axis_name}_band_{bname}_frac'] = 0.0
        feats[f'{axis_name}_spectral_centroid'] = 0.0
        feats[f'{axis_name}_spectral_spread']   = 0.0
        feats[f'{axis_name}_spectral_flatness'] = 0.0
        feats[f'{axis_name}_hi_lo_ratio']       = 0.0
        feats[f'{axis_name}_top2_freq_ratio']   = 0.0
        return feats

    # ── Pipeline: detrend → Hann → zero-pad → FFT ──────────────────────────
    arr = scipy_detrend(arr)
    win = scipy_windows.hann(n)
    win_rms = float(np.sqrt(np.mean(win ** 2))) or eps
    spectrum = np.abs(rfft(arr * win, n=n_fft))
    freqs = rfftfreq(n_fft, d=1.0 / sampling_hz)
    mags = spectrum / (n * win_rms)
    mags[1:-1] *= 2.0
    power = mags ** 2

    total_power = float(power.sum()) or eps

    # ── 1. Band energy fractions (drift-resistant) ─────────────────────────
    band_powers = {}
    feats = {}
    for bname, (flo, fhi) in bands.items():
        mask = (freqs >= flo) & (freqs < fhi)
        bp = float(power[mask].sum()) if mask.any() else 0.0
        band_powers[bname] = bp
        feats[f'{axis_name}_band_{bname}_frac'] = bp / total_power

    # ── 2. High/low band energy ratio ──────────────────────────────────────
    band_names = list(bands.keys())
    n_bands = len(band_names)
    hi_bands = band_names[n_bands // 2:]
    lo_bands = band_names[:n_bands // 2]
    hi_pow = sum(band_powers.get(b, 0.0) for b in hi_bands)
    lo_pow = sum(band_powers.get(b, 0.0) for b in lo_bands)
    feats[f'{axis_name}_hi_lo_ratio'] = hi_pow / (lo_pow + eps)

    # ── 3. Spectral centroid (Hz) ──────────────────────────────────────────
    mask_ac = freqs >= 0.5
    f_ac = freqs[mask_ac]
    p_ac = power[mask_ac]
    p_sum = float(p_ac.sum()) or eps
    centroid = float(np.sum(f_ac * p_ac) / p_sum)
    feats[f'{axis_name}_spectral_centroid'] = centroid

    # ── 4. Spectral spread (Hz) ────────────────────────────────────────────
    spread = float(np.sqrt(np.sum((f_ac - centroid) ** 2 * p_ac) / p_sum))
    feats[f'{axis_name}_spectral_spread'] = spread

    # ── 5. Spectral flatness ───────────────────────────────────────────────
    m_ac = mags[mask_ac]
    m_ac_safe = np.where(m_ac > eps, m_ac, eps)
    geom_mean = float(np.exp(np.mean(np.log(m_ac_safe))))
    arith_mean = float(np.mean(m_ac_safe)) or eps
    feats[f'{axis_name}_spectral_flatness'] = geom_mean / arith_mean

    # ── 6. Top-2 frequency ratio (harmonic structure) ──────────────────────
    m_peaks = mags.copy()
    m_peaks[~mask_ac] = 0.0
    idx1 = int(np.argmax(m_peaks))
    f1 = float(freqs[idx1])
    bw = max(1, int(0.5 * n_fft / sampling_hz))
    m_peaks[max(0, idx1 - bw): idx1 + bw + 1] = 0.0
    idx2 = int(np.argmax(m_peaks))
    f2 = float(freqs[idx2])
    feats[f'{axis_name}_top2_freq_ratio'] = f2 / (f1 + eps)

    return feats


def extract_features_windowed_drift_resistant(
    df_class, fan_state, sensor_axes, window_size, step_size,
    timestamp_col='timestamp_s', sampling_hz=100.0, n_fft=4096,
):
    """Extrai features drift-resistant por janela deslizante.

    Combina compute_drift_resistant_features com metadados de janela.
    Pode ser concatenado com extract_features_windowed_spectral e
    extract_features_windowed para criar um vetor de features completo.
    """
    rows = []
    n = len(df_class)
    if n < window_size or window_size <= 0 or step_size <= 0:
        return rows

    df_reset = df_class.reset_index(drop=True)
    for start in range(0, n - window_size + 1, step_size):
        end = start + window_size
        window_df = df_reset.iloc[start:end]
        feat = _extract_window_metadata(window_df, fan_state, timestamp_col)
        feat['window_start'] = start
        feat['window_end']   = end

        for axis in sensor_axes:
            feat.update(compute_drift_resistant_features(
                window_df[axis].values, axis,
                sampling_hz=sampling_hz, n_fft=n_fft,
            ))

        # Auto-adiciona drift-resistant features para accel_mag_g
        if 'accel_mag_g' not in sensor_axes:
            _comps = ('accel_x_g', 'accel_y_g', 'accel_z_g')
            if all(c in window_df.columns for c in _comps):
                _mag = np.sqrt(sum(window_df[c].values ** 2 for c in _comps))
                feat.update(compute_drift_resistant_features(
                    _mag, 'accel_mag_g', sampling_hz=sampling_hz, n_fft=n_fft,
                ))

        rows.append(feat)

    return rows


# ---------------------------------------------------------------------------
# Spectral moments P1–P14 (vibration analysis — frequency-domain statistics)
# ---------------------------------------------------------------------------
# Reference: statistical moments of the one-sided amplitude spectrum s(k)
# computed over K bins above f_min (default 0.5 Hz to exclude DC).
#
# Drift resistance (verified numerically — s → λ·s):
#   ✅  P3, P4, P5, P7, P8, P9, P14  — scale-invariant (amplitude cancels)
#   ❌  P1, P2, P6, P10, P11, P12, P13 — vary with amplitude
#
# Feature names produced by compute_spectral_moments_features():
#   {axis}_sp_p1 … {axis}_sp_p14
# ---------------------------------------------------------------------------

def spectral_moments_p1_p14(freqs, mags, f_min=0.5, eps=1e-12):
    """Compute spectral moment features P1–P14 from a pre-computed spectrum.

    Parameters
    ----------
    freqs : array-like — frequency axis (Hz), from rfftfreq
    mags  : array-like — one-sided amplitude spectrum (corrected for window)
    f_min : float      — lower frequency cutoff (Hz); default 0.5 avoids DC
    eps   : float      — numerical guard against division by zero

    Returns
    -------
    dict with keys 'P1' … 'P14'  (float values)
    """
    f = np.asarray(freqs, dtype=np.float64)
    s = np.asarray(mags,  dtype=np.float64)

    mask = f >= f_min
    f = f[mask]
    s = s[mask]
    K = len(f)
    if K < 2:
        return {f'P{i}': 0.0 for i in range(1, 15)}

    # ── P1: Mean spectral amplitude ─────────────────────────────────────────
    p1 = float(np.sum(s) / K)

    # ── P2: Spectral variance ───────────────────────────────────────────────
    p2 = float(np.sum((s - p1) ** 2) / (K - 1))
    p2s = max(p2, eps)          # safe p2 for normalisation

    # ── P3: Spectral skewness  (✅ drift-resistant) ─────────────────────────
    p3 = float(np.sum((s - p1) ** 3) / (K * p2s ** 1.5))

    # ── P4: Spectral kurtosis  (✅ drift-resistant) ─────────────────────────
    p4 = float(np.sum((s - p1) ** 4) / (K * p2s ** 2))

    # ── P5: Centroid frequency Hz  (✅ drift-resistant) ─────────────────────
    s_sum = max(float(np.sum(s)), eps)
    p5 = float(np.sum(f * s) / s_sum)

    # ── P6: Std of centroid frequency (÷K — NOT drift-resistant) ────────────
    p6 = float(np.sqrt(np.sum((f - p5) ** 2 * s) / K))
    p6s = max(p6, eps)

    # ── P7: Root mean square frequency  (✅ drift-resistant) ────────────────
    p7 = float(np.sqrt(np.sum(f ** 2 * s) / s_sum))

    # ── P8: Fourth moment of frequency  (✅ drift-resistant) ────────────────
    denom_p8 = max(float(np.sum(f ** 2 * s)), eps)
    p8 = float(np.sqrt(np.sum(f ** 4 * s) / denom_p8))

    # ── P9: Flattening factor  (✅ drift-resistant) ──────────────────────────
    denom_p9 = max(float(np.sqrt(np.sum(s) * np.sum(f ** 4 * s))), eps)
    p9 = float(np.sum(f ** 2 * s) / denom_p9)

    # ── P10: Coefficient of variation of centroid (÷K — NOT drift-resistant) ─
    p10 = float(p6 / max(p5, eps))

    # ── P11: Skewness of centroid frequency (÷K — NOT drift-resistant) ───────
    p11 = float(np.sum((f - p5) ** 3 * s) / (K * p6s ** 3))

    # ── P12: Kurtosis of centroid frequency (÷K — NOT drift-resistant) ───────
    p12 = float(np.sum((f - p5) ** 4 * s) / (K * p6s ** 4))

    # ── P13: Square root of centroid deviation (÷K — NOT drift-resistant) ───
    p13 = float(np.sum(np.abs(f - p5) ** 0.5 * s) / (K * max(p6s ** 0.5, eps)))

    # ── P14: RMS of centroid deviation, amplitude-weighted  (✅ drift-resistant)
    p14 = float(np.sqrt(np.sum((f - p5) ** 2 * s) / s_sum))

    return dict(P1=p1, P2=p2, P3=p3, P4=p4, P5=p5, P6=p6, P7=p7, P8=p8,
                P9=p9, P10=p10, P11=p11, P12=p12, P13=p13, P14=p14)


def compute_spectral_moments_features(values, axis_name, sampling_hz=100.0,
                                      n_fft=4096, f_min=0.5):
    """P1–P14 spectral moments for one axis window.

    Uses the same detrend + Hann + zero-pad pipeline as
    compute_spectral_signature().  Feature keys:
        {axis_name}_sp_p1  …  {axis_name}_sp_p14

    Drift-resistant features (use these for robust ML):
        sp_p3, sp_p4, sp_p5, sp_p7, sp_p8, sp_p9, sp_p14
    """
    freqs, mags, _, _, _ = compute_spectral_signature(
        values, sampling_hz=sampling_hz, n_fft=n_fft,
    )
    moments = spectral_moments_p1_p14(freqs, mags, f_min=f_min)
    return {f'{axis_name}_sp_{k.lower()}': v for k, v in moments.items()}


def extract_features_windowed_spectral_moments(
    df_class, fan_state, sensor_axes, window_size, step_size,
    timestamp_col='timestamp_s', sampling_hz=100.0, n_fft=4096, f_min=0.5,
):
    """Windowed extraction of P1–P14 spectral moments for all sensor axes.

    One row per window.  Compatible with other extract_features_windowed_*
    functions — can be merged on window index.

    Feature keys per axis: {axis}_sp_p1 … {axis}_sp_p14
    """
    rows = []
    n = len(df_class)
    if n < window_size or window_size <= 0 or step_size <= 0:
        return rows

    df_reset = df_class.reset_index(drop=True)
    for start in range(0, n - window_size + 1, step_size):
        end = start + window_size
        window_df = df_reset.iloc[start:end]
        feat = _extract_window_metadata(window_df, fan_state, timestamp_col)
        feat['window_start'] = start
        feat['window_end']   = end

        for axis in sensor_axes:
            feat.update(compute_spectral_moments_features(
                window_df[axis].values, axis,
                sampling_hz=sampling_hz, n_fft=n_fft, f_min=f_min,
            ))

        rows.append(feat)

    return rows
