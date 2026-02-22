# CHANGELOG — oracle_iot_esp32_MPU6050_project

---

## 2026-02-22 — Random Forest 7 Classes + Feature Engineering Expandido

**Notebooks:** `02_Feature_Engineering.ipynb`, `03_Model_Training_Evaluation.ipynb`
**Modelos gerados:** `rf_model_20260222.json`, `gnb_model_20260222.json`
**Status:** CONCLUIDO — RF em producao (97.34% CV)

### Feature Engineering (feature_config v5.16)

- Feature space expandido: **104 candidatas** (8 eixos × 13 metricas)
- Novos tipos de feature adicionados:
  - **Percentis:** P10, P25, P75, P90, P95 (5 novas metricas por eixo)
  - **FFT energy bands:** `fft_low` (0–5 Hz), `fft_mid` (5–10 Hz), `fft_high` (10–20 Hz)
- Janela deslizante: 100 amostras a 20 Hz (5 s), step=20 (1 s), 2.255 janelas de treino

### Selecao de Features

- Criterio Cohen's d relaxado: limiar `min_cohens_d` 2.0 → **0.30** (`d_min_all`)
- Metodo: `cohens_d_min_adjacent_classwise_corr_pairwise_score_topk`
- Filtro de correlacao classwise: threshold 0.85
- **TOP-K = 16** features finais selecionadas

### Modelos Treinados

| Modelo | Acuracia CV | Observacao |
|--------|-------------|------------|
| Random Forest (200 arvores) | **97.34% ± 0.63%** | Primario — deployado |
| Gaussian Naive Bayes | 93.70% ± 0.89% | Fallback no browser |
| Logistic Regression | ~93.97% | Referencia |

- RF: adjacent confusion rate **2.62%** (vs GNB 5.54%)
- RF: acuracia holdout 94.24% (test set separado)
- Serializacao RF: arrays planos por arvore (feature, threshold, children_left/right, value)

### classifier.js v6.0

- `Stats.percentile(arr, p)` — interpolacao linear alinhada com `np.percentile`
- `Stats.fftBandRms(arr, fLow, fHigh, samplingHz)` — DFT real O(n²), n=100
- `RandomForestClassifier._predictTree()` — traversal via arrays planos
- `ClassifierConfig.SAMPLING_HZ = 20.0` — critico para FFT correta
- Dispatch por tipo de modelo: `random_forest` → RF | `softmax_logreg` → LogReg | default → GNB

### Limpeza e Documentacao

- `model_reference/` removido (71 MB — pipeline AWS legado, aprovado em REMOVER_MODEL_REFERENCE.md)
- `logs/ml_transitions_2026*.json` removidos (83+ arquivos datados — ~29 MB)
- `tools/main.py` removido (causa MemoryError no ESP32; substituido por `main_lite.py`)
- Criado `web/doc-ml.html` — documentacao completa do pipeline ML
- `web/documentacao.html` atualizado com secao e link para `doc-ml.html`
- `README.md` reescrito com secoes de ML, Feature Engineering, Notebooks, Firmware

---

# CHANGELOG — Oracle Runtime Migration Addendum

## 2026-02-21 - Migracao completa para Oracle XE (fases 1-6)

Status: CONCLUIDO (runtime + ferramentas + guias)

Resumo da entrega:
1. Backend migrado para Python FastAPI (`backend/server.py`) com endpoints REST nativos (`/api/*`).
2. Infra local atualizada para Oracle (`docker-compose.yml`, servico `gvenzl/oracle-free`).
3. Migracao de historico MySQL -> Oracle (`tools/migrate_mysql_to_oracle.py`).
4. Pipeline de treino Oracle-first (`tools/train_model_from_db.py`).
5. Guias operacionais e variaveis (`docs/ORACLE_XE_SETUP_VSCODE.md`, `docs/ORACLE_FULL_MIGRATION_PHASES.md`, `.env.oracle.example`).

Validacoes locais executadas:
1. Validacao de conectividade Oracle via SQL*Plus (`student/oracle@//localhost:1521/xepdb1`).
2. Validacao sintatica Python dos scripts novos/alterados.

Observacao de ambiente:
- Runtime local sem dependencias do stack legado.

---
# CHANGELOG â€” IoT MPU6050 Fan Speed Classification

Registro cronologico de todas as analises exploratoras (EDA), treinamentos de modelos
e ajustes realizados no projeto. Cada entrada documenta o que foi feito, o resultado
obtido e as licoes aprendidas.

---

## 2026-02-01 (c) â€” Modelo Robusto v6: Ensemble + Knowledge Distillation

**Notebook:** `05_Robust_Ensemble_Model.ipynb`
**Modelo gerado:** `gnb_robust_20260201.json` (25 features temporais)
**Status:** SUCESSO â€” Modelo ativo em producao

**Motivacao:**
O modelo espectral v5 (4 features) apresentava confusao entre LOW e MEDIUM.
A analise de separabilidade (Cohen's d) revelou que gyro_y_dps_P14 tinha d=0.71
entre LOW/MEDIUM (muito abaixo do minimo recomendado de 2.0).

**O que foi feito:**
- Analise de Cohen's d para todas as 150 features (66 temporais + 84 espectrais)
- Treinamento de 8 modelos: GNB, Random Forest, SVM-RBF, XGBoost, LightGBM, KNN,
  Stacking (SVM+RF+LGBM com LogReg meta), Soft Voting
- Melhor modelo: Soft Voting com 98.87% de acuracia e 0 erros LOW<->MEDIUM
- Knowledge distillation: GNB treinado nas predicoes do Soft Voting para manter
  compatibilidade com classifier.js no browser
- Ajuste de variancia para features fracas do GNB destilado

**Resultado:**
- 25 features temporais selecionadas por ANOVA (Cohen's d medio = 1.56, top = 2.47)
- 0 erros de confusao LOW<->MEDIUM
- Acuracia CV ~100%
- Modelo exportado em formato GNB compativel com dashboard

**Licoes aprendidas:**
- Features espectrais (P1-P14) nao separam bem LOW/MEDIUM neste dataset
- Features temporais com ANOVA + filtro de correlacao sao mais robustas
- Knowledge distillation permite usar modelos superiores mantendo formato GNB
- Cohen's d >= 2.0 e o alvo para boa separacao entre classes

---

## 2026-02-01 (b) â€” EDA v3: Features Espectrais FFT

**Notebook:** `04_Spectral_Feature_Analysis.ipynb`
**Modelo gerado:** `gnb_model_spectral_20260201.json` (4 features)
**Status:** FALHOU â€” Confusao LOW/MEDIUM inaceitavel

**Motivacao:**
Explorar features no dominio da frequencia (FFT) para capturar padroes de vibracao
que features temporais poderiam nao detectar.

**O que foi feito:**
- Implementacao de FFT com 14 bandas de frequencia (P1-P14) por eixo
- Total: 84 features espectrais + 66 temporais = 150 features
- Selecao por ANOVA resultou em 4 features: accel_z_g_std (temporal),
  accel_x_g_P8, gyro_y_dps_P14, gyro_x_dps_P8 (espectrais)
- Taxa de amostragem: 20Hz (Nyquist 10Hz)

**Resultado:**
- Acuracia CV: 96.23% +/- 2.65%
- Confusao significativa entre LOW e MEDIUM
- Cohen's d entre LOW/MEDIUM: 0.71 a 1.66 (insuficiente)

**Licoes aprendidas:**
- 4 features e muito pouco para 3 classes â€” modelo fragil
- Features espectrais P8 e P14 capturam diferencas HIGH vs resto,
  mas nao discriminam LOW vs MEDIUM
- A taxa de 20Hz (Nyquist 10Hz) pode nao ser suficiente para diferenciar
  padroes espectrais sutis entre velocidades baixas

---

## 2026-02-01 (a) â€” EDA v2: Reprocessamento com Feature Config v5.0

**Notebook:** `03_Transition_Asymmetry_Analysis.ipynb` (re-execucao)
**Modelo gerado:** `gnb_model_v2_20260201.json` (14 features)
**Status:** PARCIAL â€” Bom em acuracia, mas baseline para comparacao

**O que foi feito:**
- Re-execucao do notebook 03 com dados atualizados
- Mesmo pipeline: sets A/B/C, analise de assimetria

**Resultado:**
- 14 features, acuracia CV ~100%
- Serviu como baseline para comparacao com modelo espectral

---

## 2026-01-31 (b) â€” EDA v2: Analise de Assimetria de Transicao

**Notebook:** `03_Transition_Asymmetry_Analysis.ipynb`
**Modelo gerado:** `gnb_model_v2_20260131.json` (7 features, Set B)
**Feature config:** v4.0
**Status:** SUCESSO PARCIAL â€” Reduziu assimetria mas nao eliminou

**Motivacao:**
Transicoes HIGH->LOW demoravam muito mais que LOW->HIGH. A hipotese era que
features de alta ordem (skew, kurtosis) convergem lentamente em janelas deslizantes,
causando atraso na deteccao quando a variancia diminui (HIGH->LOW).

**O que foi feito:**
- Analise de convergencia temporal: skew e kurtosis precisam de >50 pontos
  para estabilizar, enquanto std/rms estabilizam com ~30 pontos
- Identificacao de assimetria de variancia: HIGH tem variancia 12-27x maior
  que LOW/MEDIUM em features como gyro_z_dps_std
- Criacao de 3 conjuntos de features:
  - Set A (baseline): 14 features originais (57% skew/kurtosis)
  - Set B (max 3 high-order): 7 features com no maximo 3 skew/kurtosis
  - Set C (zero high-order): 9 features sem skew/kurtosis
- Mudanca de peak para P95 (percentil 95) â€” alinhamento com JavaScript
- Analise com diferentes scalers (Standard, Robust, MinMax, PowerTransformer)

**Resultado:**
- Set B: ratio de assimetria 3.59x (vs 16.33x do Set A original)
- Set C: menor assimetria mas perdeu discriminacao
- Acuracia CV: ~100% para todos os sets
- P95 mais robusto que max absoluto contra outliers

**Licoes aprendidas:**
- Skew e kurtosis sao features poderosas para discriminacao, mas lentas para convergir
- Em janela deslizante de 100 pontos com step 20, a "memoria" dos dados antigos
  causa inercial especialmente na direcao HIGH->LOW
- Limitar features de alta ordem a no maximo 3 melhora a simetria de transicao
- Alinhamento Python/JS e critico: ddof=0, bias=True, P95 em vez de max

---

## 2026-01-31 (a) â€” Treinamento com ANOVA: 14 Features Selecionadas

**Notebook:** `01_EDA_Feature_Engineering.ipynb` + `02_Model_Training_Evaluation.ipynb`
**Modelo gerado:** `gnb_model_20260131.json` (14 features)
**Feature config:** v3.0
**Status:** SUCESSO em acuracia, mas com problemas de transicao

**Motivacao:**
Selecionar features estatisticamente significativas em vez de usar todas as 66.

**O que foi feito:**
- EDA completa: distribuicoes, KDE, boxplots, heatmaps de correlacao, PCA, t-SNE
- ANOVA F-test com threshold alpha=0.05
- Filtro de correlacao (threshold 0.85) para remover features redundantes
- Treinamento GNB com validacao cruzada 5-fold
- Correcao critica: ddof=0 e bias=True para alinhar std/skew/kurtosis com JavaScript

**Resultado:**
- 14 features selecionadas (8 = 57% eram skew/kurtosis)
- Acuracia train: 100%, CV: 100%
- Problema: 57% de features de alta ordem causava lentidao nas transicoes

**Licoes aprendidas:**
- ANOVA seleciona bem features discriminativas, mas nao considera convergencia temporal
- Alta proporcao de skew/kurtosis e red flag para classificacao em tempo real
- Alinhamento estatistico Python/JS (ddof, bias) e pre-requisito absoluto

---

## 2026-01-30 â€” Primeiro Treinamento: 66 Features Sem Selecao

**Notebook:** `02_Model_Training_Evaluation.ipynb`
**Modelo gerado:** `gnb_model_20260130.json` (66 features)
**Status:** ARQUIVADO â€” Overfitting provavel

**O que foi feito:**
- Extracao de 66 features temporais (11 metricas x 6 eixos) com janela=100, step=20
- Treinamento GNB usando todas as 66 features sem selecao
- Metricas: mean, std, skew, kurtosis, rms, peak, root_amplitude,
  crest_factor, shape_factor, impulse_factor, clearance_factor

**Resultado:**
- Acuracia train: ~100%
- Modelo grande (66 features) com risco de overfitting

**Licoes aprendidas:**
- GNB com muitas features correlacionadas viola a premissa de independencia
- Necessario aplicar selecao de features antes do treinamento
- O modelo serviu como baseline para validar o pipeline end-to-end

---

## 2026-01-28 â€” Modelo Inicial v5.3: 6 Features Manuais

**Modelo gerado:** `multifeature_model_v5_3_20260128e.json` (6 features)
**Status:** ARQUIVADO â€” Selecao manual, sem rigor estatistico

**O que foi feito:**
- Selecao manual de 6 features baseada em intuicao:
  accel_x_g_std, accel_x_g_range, accel_x_g_rms,
  gyro_y_dps_rms, gyro_y_dps_std, gyro_y_dps_range
- Treinamento GNB basico

**Resultado:**
- Funcionava para casos simples mas falhava em transicoes rapidas
- Sem validacao cruzada formal

**Licoes aprendidas:**
- Selecao manual de features nao escala e e subjetiva
- "range" (max-min) e sensivel a outliers
- Necessario pipeline sistematico: EDA -> selecao estatistica -> treinamento -> validacao

---

## Ajustes de Parametros ML (Classifier.js)

### 2026-02-01 â€” Ajuste pos-modelo v6 robusto

**Motivacao:** Com 0 erros LOW<->MEDIUM, os parametros conservadores podiam ser relaxados.

| Parametro              | Antes | Depois | Razao                                         |
|------------------------|-------|--------|-----------------------------------------------|
| MIN_POINTS             | 50    | 40     | Modelo v6 estabiliza com menos dados          |
| SMOOTHING_ALPHA        | 0.55  | 0.65   | Mais peso para predicao atual (modelo confia) |
| HYSTERESIS_COUNT       | 4     | 3      | Menos confirmacoes necessarias                |
| CHANGE_DETECT_RATIO    | 0.30  | 0.25   | Detecta mudancas com menos divergencia        |
| FAST_FLUSH_KEEP        | 25    | 30     | Mantem mais dados recentes no flush           |
| CHANGE_DETECT_COOLDOWN | 15000 | 10000  | Menos tempo entre flushes permitidos          |
| CONFIDENCE_GATE        | 0.60  | 0.55   | Gate mais permissivo (modelo mais preciso)    |
| CONFIDENCE_MARGIN      | 0.15  | 0.12   | Margem menor entre 1a e 2a classe            |

---

## Resumo da Evolucao

```
v5.3 (6 feat, manual)
  |
  v--- Problema: selecao subjetiva, sem validacao
  |
v1.0 (66 feat, sem selecao)
  |
  v--- Problema: overfitting, muitas features correlacionadas
  |
v2.0 (14 feat, ANOVA)
  |
  v--- Problema: 57% skew/kurtosis, transicoes lentas
  |
v3.0 (7 feat, Set B, max 3 high-order)
  |
  v--- Melhoria: assimetria 3.59x (vs 16.33x), P95
  |
v4.0 (4 feat, spectral FFT)
  |
  v--- FALHA: Cohen's d = 0.71 LOW/MED, 96.23% apenas
  |
v6.0 (25 feat, ANOVA + ensemble distillation)  <-- ATIVO
  |
  v--- SUCESSO: 0 erros LOW/MED, ~100% acuracia
```

---

## Proximos Passos

- [ ] Investigar influencia da taxa de amostragem na classificacao em tempo real
- [ ] Testar treinamento a 20Hz com classificacao a taxa menor (4-10Hz)
- [ ] Coletar mais dados de transicao com teste guiado para validacao
- [ ] Avaliar necessidade de re-treinamento periodico (concept drift)


