"""Configuracao centralizada das 7 classes compostas do sistema IoT Fan Monitor.

Cada classe e derivada da combinacao de cmd_speed_label + rot_state_label:
  fan_state = f"{cmd_speed}_{rot_state_suffix}"

Importado por todos os notebooks para manter consistencia.
"""

# Ordem canonica das 7 classes (usada em graficos, eixos, legend, etc.)
CLASS_ORDER = [
    'LOW_ROT_ON',
    'MEDIUM_ROT_ON',
    'HIGH_ROT_ON',
    'LOW_ROT_OFF',
    'MEDIUM_ROT_OFF',
    'HIGH_ROT_OFF',
    'FAN_OFF',
]

# Cores para visualizacoes
# ROT_ON = cores vibrantes, ROT_OFF = cores desbotadas/muted, FAN_OFF = cinza
COLOR_MAP = {
    'LOW_ROT_ON':      '#22c55e',  # verde vibrante
    'MEDIUM_ROT_ON':   '#f59e0b',  # amarelo/laranja vibrante
    'HIGH_ROT_ON':     '#ef4444',  # vermelho vibrante
    'LOW_ROT_OFF':     '#86efac',  # verde claro/muted
    'MEDIUM_ROT_OFF':  '#fcd34d',  # amarelo claro/muted
    'HIGH_ROT_OFF':    '#fca5a5',  # vermelho claro/muted
    'FAN_OFF':         '#9ca3af',  # cinza
}

# Regras de composicao: (cmd_speed_label, rot_state_label) -> fan_state
COMPOSITE_RULES = {
    ('LOW', 'ROTATING'):     'LOW_ROT_ON',
    ('MEDIUM', 'ROTATING'):  'MEDIUM_ROT_ON',
    ('HIGH', 'ROTATING'):    'HIGH_ROT_ON',
    ('LOW', 'STOPPED'):      'LOW_ROT_OFF',
    ('MEDIUM', 'STOPPED'):   'MEDIUM_ROT_OFF',
    ('HIGH', 'STOPPED'):     'HIGH_ROT_OFF',
    ('OFF', 'STOPPED'):      'FAN_OFF',
}

# Valores SQL para WHERE clause
FILTER_LABELS_SQL = {
    'cmd_speed': ['LOW', 'MEDIUM', 'HIGH', 'OFF'],
    'rot_state': ['ROTATING', 'STOPPED'],
}

# Classes legadas (3 classes) para backward-compatibility
LEGACY_CLASS_ORDER = ['LOW', 'MEDIUM', 'HIGH']
LEGACY_COLOR_MAP = {
    'LOW':    '#22c55e',
    'MEDIUM': '#f59e0b',
    'HIGH':   '#ef4444',
}


def derive_composite_label(df):
    """Cria coluna 'fan_state' composta a partir de cmd_speed_label + rot_state_label.

    Backward-compatible: se as colunas nao existirem no DataFrame, retorna df inalterado.
    Se fan_state ja existe com valores legados (LOW/MEDIUM/HIGH), mantém inalterado
    quando as colunas de label nao estao presentes.

    Parameters
    ----------
    df : pandas.DataFrame
        DataFrame com colunas opcionais 'cmd_speed_label' e 'rot_state_label'.

    Returns
    -------
    pandas.DataFrame
        DataFrame com coluna 'fan_state' atualizada (ou inalterada).
    """
    if 'cmd_speed_label' not in df.columns or 'rot_state_label' not in df.columns:
        return df

    df = df.copy()

    def _map_row(row):
        key = (str(row['cmd_speed_label']).strip().upper(),
               str(row['rot_state_label']).strip().upper())
        return COMPOSITE_RULES.get(key, f"UNKNOWN_{key[0]}_{key[1]}")

    df['fan_state'] = df.apply(_map_row, axis=1)
    return df


def is_composite_labels(df):
    """Verifica se o DataFrame usa labels compostos (7 classes) ou legados (3 classes).

    Returns True se fan_state contem pelo menos um valor do CLASS_ORDER de 7 classes.
    """
    if 'fan_state' not in df.columns:
        return False
    unique_labels = set(df['fan_state'].unique())
    return bool(unique_labels & set(CLASS_ORDER))


def get_active_classes(df):
    """Retorna a lista de classes presentes no DataFrame, na ordem canonica.

    Util para notebooks que precisam adaptar-se dinamicamente ao numero de classes.
    """
    if 'fan_state' not in df.columns:
        return []
    present = set(df['fan_state'].unique())
    # Tentar ordem de 7 classes primeiro
    ordered = [c for c in CLASS_ORDER if c in present]
    if ordered:
        return ordered
    # Fallback para 3 classes legadas
    ordered = [c for c in LEGACY_CLASS_ORDER if c in present]
    return ordered


def get_color_map(df):
    """Retorna o mapa de cores adequado ao tipo de labels no DataFrame."""
    if is_composite_labels(df):
        return COLOR_MAP
    return LEGACY_COLOR_MAP
