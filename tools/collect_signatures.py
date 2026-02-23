"""
collect_signatures.py
─────────────────────
Assistente de coleta das 7 assinaturas espectrais do ventilador.

Uso (PowerShell na pasta do projeto):
    py -3.11 tools/collect_signatures.py

O que faz:
  1. Cria uma nova collection_id de 100 Hz via /api/set_mode
  2. Para cada uma das 7 condições:
       a. Envia o chaveamento de labels para o backend (sem tocar no control.html)
       b. Marca transition_marker=1 e exibe contagem regressiva do transiente
       c. Marca transition_marker=0 e exibe contagem regressiva da coleta limpa
       d. Verifica amostras chegando via /api/get_data a cada 10 s
  3. Imprime resumo final com amostras coletadas por classe

Parâmetros ajustáveis no topo do arquivo:
  SETTLE_SEC   — tempo de espera após chaveamento (transitório)
  COLLECT_SEC  — tempo de coleta por condição
  SAMPLE_RATE  — taxa de amostragem (Hz)
  API_BASE     — URL do backend
"""

import sys
import time
import json
import urllib.request
import urllib.error

# ─── Configuração ──────────────────────────────────────────────────────────────
API_BASE     = "http://127.0.0.1:8000"
AUTH_TOKEN   = "F0xb@m986960440"
DEVICE_ID    = "ESP32_MPU6050_ORACLE"
SAMPLE_RATE  = 100      # Hz
SETTLE_SEC   = 30       # segundos de espera para transitório dissipar
COLLECT_SEC  = 180      # segundos de coleta limpa por condição (3 min)

# 7 condições na ordem recomendada (FAN_OFF primeiro como baseline)
CONDITIONS = [
    {
        "fan_state":    "FAN_OFF",
        "mode":         "OFF",
        "cmd_speed":    "OFF",
        "rot_state":    "STOPPED",
        "desc":         "Ventilador DESLIGADO",
        "instruction":  "Desligue o ventilador completamente",
    },
    {
        "fan_state":    "LOW_ROT_OFF",
        "mode":         "LOW",
        "cmd_speed":    "LOW",
        "rot_state":    "STOPPED",
        "desc":         "Baixa Vel. — SEM rotação do suporte",
        "instruction":  "Ligue o ventilador em BAIXA velocidade. Trave o suporte (sem girar)",
    },
    {
        "fan_state":    "LOW_ROT_ON",
        "mode":         "LOW",
        "cmd_speed":    "LOW",
        "rot_state":    "ROTATING",
        "desc":         "Baixa Vel. — COM rotação do suporte",
        "instruction":  "Mantenha BAIXA velocidade. Libere o suporte para girar",
    },
    {
        "fan_state":    "MEDIUM_ROT_OFF",
        "mode":         "MEDIUM",
        "cmd_speed":    "MEDIUM",
        "rot_state":    "STOPPED",
        "desc":         "Média Vel. — SEM rotação do suporte",
        "instruction":  "Mude para MÉDIA velocidade. Trave o suporte",
    },
    {
        "fan_state":    "MEDIUM_ROT_ON",
        "mode":         "MEDIUM",
        "cmd_speed":    "MEDIUM",
        "rot_state":    "ROTATING",
        "desc":         "Média Vel. — COM rotação do suporte",
        "instruction":  "Mantenha MÉDIA velocidade. Libere o suporte para girar",
    },
    {
        "fan_state":    "HIGH_ROT_OFF",
        "mode":         "HIGH",
        "cmd_speed":    "HIGH",
        "rot_state":    "STOPPED",
        "desc":         "Alta Vel. — SEM rotação do suporte",
        "instruction":  "Mude para ALTA velocidade. Trave o suporte",
    },
    {
        "fan_state":    "HIGH_ROT_ON",
        "mode":         "HIGH",
        "cmd_speed":    "HIGH",
        "rot_state":    "ROTATING",
        "desc":         "Alta Vel. — COM rotação do suporte",
        "instruction":  "Mantenha ALTA velocidade. Libere o suporte para girar",
    },
]

# ─── Helpers de I/O ────────────────────────────────────────────────────────────

BOLD  = "\033[1m"
GREEN = "\033[92m"
CYAN  = "\033[96m"
YELLOW= "\033[93m"
RED   = "\033[91m"
GREY  = "\033[90m"
RESET = "\033[0m"

def _clr(text, color):
    return f"{color}{text}{RESET}"

def _bar(elapsed, total, width=30):
    filled = int(width * elapsed / total)
    bar = "█" * filled + "░" * (width - filled)
    pct = int(100 * elapsed / total)
    return f"[{bar}] {pct:3d}%"

def _fmt_time(secs):
    m, s = divmod(int(secs), 60)
    return f"{m:02d}:{s:02d}"

def _println(msg):
    sys.stdout.write(f"\r{msg}\033[K")
    sys.stdout.flush()

def _header(text):
    w = 60
    print("\n" + "═" * w)
    print(f"  {_clr(text, BOLD)}")
    print("═" * w)

# ─── API helpers ───────────────────────────────────────────────────────────────

def _api_post(path, payload):
    url  = f"{API_BASE}{path}"
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(
        url, data=data,
        headers={
            "Content-Type":  "application/json",
            "Authorization": f"Bearer {AUTH_TOKEN}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"\n{_clr('ERRO API', RED)} {e.code}: {body}")
        return None
    except Exception as e:
        print(f"\n{_clr('ERRO conexão', RED)}: {e}")
        return None

def _api_get(path, params=""):
    url = f"{API_BASE}{path}?{params}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {AUTH_TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None

def _set_state(mode, cmd_speed, rot_state, transition, collection_id):
    return _api_post("/api/set_mode", {
        "device_id":        DEVICE_ID,
        "mode":             mode,
        "cmd_speed_label":  cmd_speed,
        "rot_state_label":  rot_state,
        "transition_marker": 1 if transition else 0,
        "collection_id":    collection_id,
        "sample_rate":      SAMPLE_RATE,
        "label_source":     "COLLECT_WIZARD",
    })

def _check_samples(collection_id, fan_state):
    """Retorna contagem de amostras coletadas para esta condição."""
    data = _api_get(
        "/api/get_data",
        f"mode=stats&device_id={DEVICE_ID}&collection_id={collection_id}"
    )
    if not data:
        return 0
    return int((data.get("overall") or {}).get("count", 0))

# ─── Contagem regressiva ────────────────────────────────────────────────────────

def _countdown(label, total_sec, color=CYAN, check_fn=None):
    """Exibe barra de progresso com contagem regressiva ao vivo."""
    start = time.time()
    last_check = 0
    samples = 0

    while True:
        elapsed = time.time() - start
        remaining = max(0, total_sec - elapsed)

        if check_fn and (elapsed - last_check) >= 10:
            samples = check_fn()
            last_check = elapsed

        bar   = _bar(min(elapsed, total_sec), total_sec)
        timer = _fmt_time(remaining)
        smpl  = f"  {_clr(f'{samples:,} amostras', GREY)}" if check_fn else ""
        _println(f"  {_clr(label, color)} {bar}  {_clr(timer, BOLD)}{smpl}")

        if elapsed >= total_sec:
            break
        time.sleep(0.25)

    print()  # nova linha após completar

# ─── Verificação de pré-condições ─────────────────────────────────────────────

def _preflight():
    print(_clr("\n  Verificando backend...", GREY), end="")
    data = _api_get("/health")
    if not data or data.get("status") != "ok":
        print(f"\n{_clr('  ERRO', RED)}: backend não responde em {API_BASE}")
        print("  Execute start.ps1 antes de rodar este script.")
        sys.exit(1)
    db_ok = data.get("db") == "OK"
    print(f"  {_clr('OK', GREEN)}  |  DB: {_clr('OK', GREEN) if db_ok else _clr('FALHA', RED)}")
    if not db_ok:
        print(f"{_clr('  ERRO', RED)}: Oracle não conectado.")
        sys.exit(1)

    print(_clr("  Verificando ESP32...", GREY), end="")
    live = _api_get("/api/get_data", f"mode=debug&device_id={DEVICE_ID}")
    if live and int(live.get("total_rows", 0)) > 0:
        print(f"  {_clr('OK', GREEN)}  (dados presentes no banco)")
    else:
        print(f"  {_clr('ATENÇÃO', YELLOW)}: sem dados recentes — confirme que o ESP32 está enviando")

# ─── Fluxo principal ───────────────────────────────────────────────────────────

def run():
    _header("COLETA DE ASSINATURAS ESPECTRAIS — 7 CLASSES")
    _preflight()

    # Criar nova collection
    print(f"\n  Criando nova coleta a {SAMPLE_RATE} Hz...")
    resp = _api_post("/api/set_mode", {
        "device_id":     DEVICE_ID,
        "new_collection": True,
        "sample_rate":   SAMPLE_RATE,
        "label_source":  "COLLECT_WIZARD",
    })
    if not resp:
        print(f"{_clr('ERRO', RED)}: não foi possível criar a coleta. Abortando.")
        sys.exit(1)

    collection_id = resp.get("collection_id", "desconhecido")
    print(f"  {_clr('Collection ID:', BOLD)} {_clr(collection_id, CYAN)}")
    print(f"  {_clr('Duração estimada:', BOLD)} ~{_fmt_time(len(CONDITIONS) * (SETTLE_SEC + COLLECT_SEC))}")

    samples_per_class = {}
    inicio_total = time.time()

    for i, cond in enumerate(CONDITIONS, 1):
        fan_state   = cond["fan_state"]
        mode        = cond["mode"]
        cmd_speed   = cond["cmd_speed"]
        rot_state   = cond["rot_state"]
        desc        = cond["desc"]
        instruction = cond["instruction"]

        # ── Cabeçalho da condição ─────────────────────────────────────────────
        print(f"\n{'─'*60}")
        print(f"  {_clr(f'[{i}/7]', BOLD)}  {_clr(fan_state, YELLOW)}  —  {desc}")
        print(f"{'─'*60}")
        print(f"\n  {_clr('AÇÃO:', BOLD)} {instruction}")

        # ── Chaveamento (com transition_marker=1) ─────────────────────────────
        r = _set_state(mode, cmd_speed, rot_state, transition=True,
                       collection_id=collection_id)
        if r is None:
            print(f"  {_clr('AVISO', YELLOW)}: falha ao enviar estado. Continuando mesmo assim.")

        input(f"\n  {_clr('Pressione ENTER quando estiver pronto...', BOLD)}")

        # ── Transiente ────────────────────────────────────────────────────────
        print(f"\n  {_clr('⏳ TRANSIENTE — aguardando estabilização', YELLOW)}")
        print(f"  {_clr('(dados marcados como transition=1, serão descartados na análise)', GREY)}")
        _countdown("Transiente:", SETTLE_SEC, color=YELLOW)

        # ── Limpa transition_marker → inicia coleta limpa ─────────────────────
        _set_state(mode, cmd_speed, rot_state, transition=False,
                   collection_id=collection_id)

        print(f"  {_clr('● COLETANDO', GREEN)}  {_clr(fan_state, BOLD)}")

        samples_before = _check_samples(collection_id, fan_state)
        _countdown(
            "Coleta:    ",
            COLLECT_SEC,
            color=GREEN,
            check_fn=lambda cid=collection_id, fs=fan_state: _check_samples(cid, fs),
        )
        samples_after = _check_samples(collection_id, fan_state)
        captured = max(0, samples_after - samples_before)
        samples_per_class[fan_state] = captured
        expected = COLLECT_SEC * SAMPLE_RATE
        status = _clr("✓", GREEN) if captured >= int(expected * 0.85) else _clr("!", YELLOW)
        print(f"  {status} {_clr(f'{captured:,}', BOLD)} amostras capturadas  "
              f"{_clr(f'(esperado ~{expected:,})', GREY)}")

    # ── Resumo final ──────────────────────────────────────────────────────────
    elapsed_total = time.time() - inicio_total
    _header("COLETA CONCLUÍDA")
    print(f"  Collection ID : {_clr(collection_id, CYAN)}")
    print(f"  Duração total : {_clr(_fmt_time(elapsed_total), BOLD)}")
    print(f"\n  {'Classe':<20} {'Amostras':>10}  {'Status'}")
    print(f"  {'─'*20}  {'─'*10}  {'─'*10}")

    total = 0
    for cond in CONDITIONS:
        fs  = cond["fan_state"]
        n   = samples_per_class.get(fs, 0)
        exp = COLLECT_SEC * SAMPLE_RATE
        ok  = n >= int(exp * 0.85)
        st  = _clr("OK", GREEN) if ok else _clr("INCOMPLETO", YELLOW)
        print(f"  {fs:<20} {n:>10,}  {st}")
        total += n

    print(f"\n  {_clr('Total geral:', BOLD)} {_clr(f'{total:,} amostras', CYAN)}")
    print(f"\n  {_clr('Próximo passo:', BOLD)}")
    print(f"  Abra o Notebook 04 e execute a análise com:")
    cid_line = '  COLLECTION_ID = "' + collection_id + '"'
    print(f"  {_clr(cid_line, CYAN)}")
    print(f"  {_clr('  SAMPLE_HZ     = 100', CYAN)}")
    print(f"  {_clr('  WINDOW_SIZE   = 1000   # 10s → Δf = 0.1 Hz', CYAN)}")
    print()


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        print(f"\n\n  {_clr('Coleta interrompida pelo usuário.', YELLOW)}")
        sys.exit(0)
