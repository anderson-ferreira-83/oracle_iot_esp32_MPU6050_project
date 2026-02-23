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
    'rot':   (0.10,  1.50),   # rotation component  (~0.25 Hz = 1 rot/4s)
    'vel1':  (3.00,  6.50),   # LOW  speed vibration (~5 Hz)
    'vel2':  (6.50,  9.50),   # MED  speed vibration (~7.5 Hz)
    'vel3':  (9.50, 14.00),   # HIGH speed vibration (~10–12 Hz)
    'noise': (25.0, 50.00),   # high-freq noise floor (reference)
}


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

        rows.append(feat)

    return rows
