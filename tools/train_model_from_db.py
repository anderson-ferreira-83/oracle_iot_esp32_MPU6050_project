import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, confusion_matrix
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.naive_bayes import GaussianNB
from sqlalchemy import create_engine

# --- PATHS ---
ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS_DIR = ROOT / 'artifacts' / 'features_by_rate'
MODELS_DIR = ROOT / 'models'
MODEL_INDEX_PATH = MODELS_DIR / 'MODEL_INDEX.json'
REGISTRY_PATH = MODELS_DIR / 'MODEL_REGISTRY.json'

# --- IMPORT TRACEABILITY HELPERS ---
sys.path.insert(0, str(ROOT / 'notebooks'))
from shared.traceability import hash_file, save_json, utc_now_iso

# --- CONFIGURACOES ---
WINDOW_SIZE = 100
STEP_SIZE = 20
MIN_SAMPLES_PER_CLASS = 50
LABELS = ['LOW', 'MEDIUM', 'HIGH']
FEATURES = [
    'accel_x_g_std',
    'accel_x_g_range',
    'accel_x_g_rms',
    'gyro_y_dps_std',
    'gyro_y_dps_range',
    'gyro_y_dps_rms',
]


def _db_connection_str():
    explicit = os.getenv('DB_CONNECTION_STR')
    if explicit:
        return explicit

    user = os.getenv('ORACLE_USER', 'student')
    password = quote_plus(os.getenv('ORACLE_PASSWORD', 'oracle'))
    host = os.getenv('ORACLE_HOST', 'localhost')
    port = os.getenv('ORACLE_PORT', '1521')
    service = os.getenv('ORACLE_SERVICE_NAME', 'xepdb1')
    return f'oracle+oracledb://{user}:{password}@{host}:{port}/?service_name={service}'


def _rate_key(rate_value):
    try:
        return int(round(float(rate_value)))
    except Exception:
        return None


def _axis_array(window_df, axis_name: str):
    # Direct column
    if axis_name in window_df.columns:
        return window_df[axis_name].values.astype(float)

    # Backwards/aliases
    if axis_name == 'vibration_dps' and 'vibration' in window_df.columns:
        return window_df['vibration'].values.astype(float)

    # Derived axes
    if axis_name == 'accel_mag_g' and all(c in window_df.columns for c in ('accel_x_g', 'accel_y_g', 'accel_z_g')):
        ax = window_df['accel_x_g'].values.astype(float)
        ay = window_df['accel_y_g'].values.astype(float)
        az = window_df['accel_z_g'].values.astype(float)
        return np.sqrt(ax ** 2 + ay ** 2 + az ** 2)

    if axis_name == 'gyro_mag_dps' and all(c in window_df.columns for c in ('gyro_x_dps', 'gyro_y_dps', 'gyro_z_dps')):
        gx = window_df['gyro_x_dps'].values.astype(float)
        gy = window_df['gyro_y_dps'].values.astype(float)
        gz = window_df['gyro_z_dps'].values.astype(float)
        return np.sqrt(gx ** 2 + gy ** 2 + gz ** 2)

    return None


def _metric_value(arr: np.ndarray, metric: str) -> float:
    if arr is None or arr.size == 0:
        return 0.0
    if metric == 'std':
        return float(np.std(arr, ddof=0))
    if metric == 'rms':
        return float(np.sqrt(np.mean(arr ** 2)))
    if metric == 'range':
        return float(np.max(arr) - np.min(arr))
    if metric == 'mean':
        return float(np.mean(arr))
    if metric == 'peak':
        return float(np.max(np.abs(arr)))
    raise ValueError(f'Unsupported metric: {metric}')


def _compute_features(window_df, feature_names):
    # Parse features like: axis_metric (e.g., gyro_y_dps_std)
    feats = {}
    cache = {}

    # Keep this script aligned with the deployed JS basic set.
    # If you need more metrics, prefer the notebook pipeline (shared/feature_engineering.py).
    metrics = ['rms', 'peak', 'range', 'std', 'mean']

    for fname in feature_names:
        metric = None
        for m in metrics:
            if fname.endswith(f'_{m}'):
                metric = m
                break
        if not metric:
            continue
        axis = fname[:-(len(metric) + 1)]
        if axis not in cache:
            cache[axis] = _axis_array(window_df, axis)
        arr = cache[axis]
        feats[fname] = _metric_value(arr, metric)

    return feats


def _extract_features_by_rate(df_rate, rate_key):
    rows = []
    for label in LABELS:
        df_state = df_rate[df_rate['fan_state'] == label].reset_index(drop=True)
        if len(df_state) < WINDOW_SIZE:
            continue
        for start in range(0, len(df_state) - WINDOW_SIZE + 1, STEP_SIZE):
            window = df_state.iloc[start:start + WINDOW_SIZE]
            feats = _compute_features(window, FEATURES)
            feats['label'] = label
            feats['sample_rate_hz'] = rate_key
            feats['collection_id'] = window['collection_id'].iloc[0] if 'collection_id' in window.columns else None
            rows.append(feats)
    return rows


def _load_registry():
    if REGISTRY_PATH.exists():
        with open(REGISTRY_PATH, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    return {'registry_version': '1.0', 'updated_at': utc_now_iso(), 'models': []}


def _save_registry(registry):
    registry['updated_at'] = utc_now_iso()
    with open(REGISTRY_PATH, 'w', encoding='utf-8') as handle:
        json.dump(registry, handle, indent=2)


def _load_model_index():
    if MODEL_INDEX_PATH.exists():
        with open(MODEL_INDEX_PATH, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    return {
        'version': '1.0',
        'generated_at': utc_now_iso(),
        'default_model': None,
        'models_by_rate': {},
    }


def _save_model_index(index_data):
    index_data['generated_at'] = utc_now_iso()
    with open(MODEL_INDEX_PATH, 'w', encoding='utf-8') as handle:
        json.dump(index_data, handle, indent=2)


def main():
    global WINDOW_SIZE, STEP_SIZE, FEATURES

    # Optional: load current feature_config.json (selected_features + window/step)
    try:
        fc_path = ROOT / 'config' / 'feature_config.json'
        if fc_path.exists():
            with open(fc_path, 'r', encoding='utf-8') as f:
                fc = json.load(f)
            if isinstance(fc.get('selected_features'), list) and fc['selected_features']:
                FEATURES = fc['selected_features']
            if fc.get('window_size') is not None:
                WINDOW_SIZE = int(fc['window_size'])
            if fc.get('step_size') is not None:
                STEP_SIZE = int(fc['step_size'])
            print(f"[AUTO] feature_config.json carregado: v{fc.get('version', '?')}  features={len(FEATURES)}  window={WINDOW_SIZE}  step={STEP_SIZE}")
    except Exception as e:
        print(f'[AVISO] Nao foi possivel carregar feature_config.json: {e}')

    print(f'--- TREINAMENTO MULTI-TAXA (GNB {len(FEATURES)} FEATURES) ---')
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    db_connection_str = _db_connection_str()
    print(f'[1/6] Conectando ao Oracle: {db_connection_str}')
    engine = create_engine(db_connection_str)
    query = """
        SELECT * FROM sensor_data
        WHERE fan_state IN ('LOW', 'MEDIUM', 'HIGH')
        ORDER BY ts_epoch ASC
    """
    df_raw = pd.read_sql(query, engine)

    if df_raw.empty:
        print('Nenhum dado encontrado para treino.')
        return

    df_raw['rate_key'] = df_raw['sample_rate'].apply(_rate_key)
    df_raw = df_raw[df_raw['rate_key'].notnull()].copy()

    rate_keys = sorted(df_raw['rate_key'].unique())
    print(f'Taxas encontradas: {rate_keys}')

    registry = _load_registry()
    model_index = _load_model_index()

    for rate in rate_keys:
        df_rate = df_raw[df_raw['rate_key'] == rate].copy()
        print(f'\n--- Treinando para {rate} Hz ---')

        counts = df_rate['fan_state'].value_counts().to_dict()
        if any(counts.get(label, 0) < MIN_SAMPLES_PER_CLASS for label in LABELS):
            print(f'Amostras insuficientes para {rate} Hz: {counts}')
            continue

        rows = _extract_features_by_rate(df_rate, rate)
        if not rows:
            print(f'Nenhuma janela gerada para {rate} Hz.')
            continue

        df_feat = pd.DataFrame(rows)
        features_path = ARTIFACTS_DIR / f'features_rate_{rate}hz_{datetime.now().strftime("%Y%m%d_%H%M%S")}.csv'
        df_feat.to_csv(features_path, index=False)
        features_hash = hash_file(features_path)

        X = df_feat[FEATURES].values
        y = df_feat['label'].values

        cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
        model = GaussianNB()
        scores = cross_val_score(model, X, y, cv=cv, scoring='accuracy')

        model.fit(X, y)
        y_pred = model.predict(X)
        train_acc = accuracy_score(y, y_pred)
        cm = confusion_matrix(y, y_pred, labels=LABELS)

        stats = {}
        priors = {}
        for idx, label in enumerate(model.classes_):
            priors[label] = float(model.class_prior_[idx])
            stats[label] = {}
            for feat_idx, feat in enumerate(FEATURES):
                stats[label][feat] = {
                    'mean': float(model.theta_[idx, feat_idx]),
                    'var': float(model.var_[idx, feat_idx]),
                    'count': int(np.sum(y == label)),
                }

        model_filename = f'gnb_model_rate_{rate}hz_{datetime.now().strftime("%Y%m%d")}.json'
        model_path = MODELS_DIR / model_filename

        export_data = {
            'type': 'gaussian_nb_3class',
            'version': f'multirate_{rate}hz_{datetime.now().strftime("%Y%m%d")}',
            'generated_at': utc_now_iso(),
            'generated_by': 'tools/train_model_from_db.py',
            'sample_rate_hz': rate,
            'labels': LABELS,
            'features': FEATURES,
            'feature_count': len(FEATURES),
            'priors': priors,
            'stats': stats,
            'metrics': {
                'train_accuracy': float(train_acc),
                'cv_accuracy_mean': float(scores.mean()),
                'cv_accuracy_std': float(scores.std()),
                'confusion_matrix': {
                    LABELS[i]: {LABELS[j]: int(cm[i, j]) for j in range(len(LABELS))}
                    for i in range(len(LABELS))
                },
            },
            'training_info': {
                'total_samples': int(len(df_feat)),
                'raw_samples': int(len(df_rate)),
                'window_size': WINDOW_SIZE,
                'step_size': STEP_SIZE,
                'sample_rate_hz': rate,
                'class_distribution': {k: int(v) for k, v in df_feat['label'].value_counts().to_dict().items()},
                'collection_ids': sorted(df_rate['collection_id'].dropna().unique().tolist()) if 'collection_id' in df_rate.columns else [],
            },
            'traceability': {
                'features_csv': str(features_path),
                'features_csv_hash': features_hash,
                'rate_key': rate,
                'source_table': 'sensor_data',
            }
        }

        with open(model_path, 'w', encoding='utf-8') as handle:
            json.dump(export_data, handle, indent=2)

        print(f'Modelo salvo: {model_path}')
        print(f'CV acc: {scores.mean():.4f}  Train acc: {train_acc:.4f}')

        # Atualizar registry
        registry['models'].append({
            'filename': model_filename,
            'version': export_data['version'],
            'date': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
            'notebook': None,
            'feature_selection': 'fixed_6_features',
            'features_count': len(FEATURES),
            'features': FEATURES,
            'accuracy_train': train_acc,
            'accuracy_cv': scores.mean(),
            'accuracy_test': None,
            'status': 'active',
            'deployed': False,
            'parent_model': None,
            'feature_config_version': None,
            'sample_rate_hz': rate,
            'window_size': WINDOW_SIZE,
            'step_size': STEP_SIZE,
            'traceability': {
                'features_csv_hash': features_hash,
                'features_csv': str(features_path),
            }
        })

        # Atualizar index
        model_index['models_by_rate'][str(rate)] = f'../models/{model_filename}'

    _save_registry(registry)

    # Define default model como a maior taxa disponivel
    if model_index['models_by_rate']:
        default_rate = sorted(int(r) for r in model_index['models_by_rate'].keys())[-1]
        model_index['default_model'] = model_index['models_by_rate'][str(default_rate)]

    _save_model_index(model_index)
    print('\nMODEL_INDEX.json atualizado.')


if __name__ == '__main__':
    # Dependencias:
    # pip install pandas sqlalchemy oracledb scikit-learn
    main()


