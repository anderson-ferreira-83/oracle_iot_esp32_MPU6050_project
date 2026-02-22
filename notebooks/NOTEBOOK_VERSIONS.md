# Versionamento dos Notebooks

Registro de versoes, proposito e outputs de cada notebook do projeto.

---

## 01_EDA_Feature_Engineering.ipynb

**Proposito:** Analise exploratoria de dados (EDA) e selecao de features.

**Pipeline:**
1. Conexao ao banco MySQL e extracao dos dados brutos (6 eixos + timestamp + fan_state)
2. Segmentacao em janelas (WINDOW_SIZE=100, STEP=20)
3. Extracao de 66 features temporais (11 metricas x 6 eixos)
4. ANOVA F-test para ranking de features por poder discriminativo
5. Filtro de correlacao (threshold=0.85) para remover features redundantes
6. Exportacao de feature_config.json e CSVs

**Outputs gerados:**
- `config/feature_config.json` — features selecionadas (versao atual: 5.0 com 25 features)
- `output/data/raw_sensor_data_YYYYMMDD_HHMMSS.csv` — dados brutos com timestamp e sample rate
- `output/data/features_extracted_YYYYMMDD_HHMMSS.csv` — features extraidas por janela
- `output/data/features_latest.csv` — copia para uso pelo notebook 02
- `output/metrics/analise_exploratoria_summary.json` — resumo da analise
- `output/figures/` — distribuicoes, KDE, boxplots, heatmaps, PCA, t-SNE

**Historico de execucoes:**
| Data | feature_config | Features selecionadas | Observacao |
|------|---------------|----------------------|------------|
| 2026-01-31 | v3.0 | 14 (57% skew/kurtosis) | Primeira selecao ANOVA |
| 2026-02-01 | v5.0 | 25 temporais | Re-execucao com dados 20Hz, filtro corr=0.85 |

---

## 02_Model_Training_Evaluation.ipynb

**Proposito:** Treinamento de modelo GaussianNB e avaliacao com validacao cruzada.

**Pipeline:**
1. Carrega features_latest.csv
2. Filtra features conforme feature_config.json
3. Split 80/20 estratificado
4. Treina GNB com ddof=0, bias=True (alinhado com JavaScript)
5. Validacao cruzada 5-fold
6. Matriz de confusao e metricas por classe
7. Exporta modelo JSON (priors + mean/var por classe/feature)
8. Celula de deploy: copia modelo para models/ e atualiza MODEL_URL no dashboard.js

**Modelos gerados:**
| Data | Modelo | Features | Acuracia CV |
|------|--------|----------|-------------|
| 2026-01-30 | gnb_model_20260130.json | 66 (todas) | ~100% |
| 2026-01-31 | gnb_model_20260131.json | 14 (ANOVA) | 100% |

---

## 03_Transition_Asymmetry_Analysis.ipynb

**Proposito:** Investigar e corrigir assimetria nas transicoes (HIGH->LOW lento vs LOW->HIGH rapido).

**Pipeline:**
1. Analise de convergencia temporal das features (quantos pontos para estabilizar)
2. Calculo de assimetria de variancia entre classes
3. Criacao de sets de features alternativos (A, B, C) limitando skew/kurtosis
4. Treinamento e comparacao dos sets
5. Mudanca de peak absoluto para P95 (percentil 95)

**Modelos gerados:**
| Data | Modelo | Set | Features | Assimetria |
|------|--------|-----|----------|------------|
| 2026-01-31 | gnb_model_v2_20260131.json | B | 7 | 3.59x |
| 2026-02-01 | gnb_model_v2_20260201.json | baseline | 14 | — |

**Descobertas principais:**
- skew/kurtosis precisam de >50 pontos para convergir (std/rms: ~30)
- Variancia de HIGH e 12-27x maior que LOW/MEDIUM
- Set B (max 3 high-order) reduziu assimetria de 16.33x para 3.59x

---

## 04_Spectral_Feature_Analysis.ipynb

**Proposito:** Explorar features no dominio da frequencia (FFT) para melhorar discriminacao.

**Pipeline:**
1. Implementacao de FFT por eixo com 14 bandas (P1-P14)
2. Extracao de 84 features espectrais (14 bandas x 6 eixos)
3. Combinacao com 66 temporais = 150 features totais
4. Selecao ANOVA sobre o conjunto combinado
5. Analise de Cohen's d para separabilidade entre classes

**Modelos gerados:**
| Data | Modelo | Features | Acuracia CV | Status |
|------|--------|----------|-------------|--------|
| 2026-02-01 | gnb_model_spectral_20260201.json | 4 | 96.23% | FALHOU |

**Descobertas principais:**
- Features espectrais nao discriminam LOW vs MEDIUM (Cohen's d = 0.71)
- 4 features e insuficiente para 3 classes
- Taxa de 20Hz limita resolucao espectral

---

## 05_Robust_Ensemble_Model.ipynb

**Proposito:** Resolver confusao LOW/MEDIUM com modelos avancados e ensemble.

**Pipeline:**
1. Diagnostico: Cohen's d para todas as 150 features entre LOW/MEDIUM
2. Treinamento de 8 modelos (GNB, RF, SVM-RBF, XGBoost, LightGBM, KNN, Stacking, Soft Voting)
3. Comparacao detalhada com foco em erros LOW<->MEDIUM
4. Selecao do melhor modelo
5. Knowledge distillation: GNB treinado nas predicoes do ensemble
6. Ajuste de variancia para features fracas
7. Exportacao em formato JSON compativel com classifier.js

**Modelos gerados:**
| Data | Modelo | Features | Acuracia | LOW/MED erros | Status |
|------|--------|----------|----------|---------------|--------|
| 2026-02-01 | gnb_robust_20260201.json | 25 | ~100% | 0 | ATIVO |

**Descobertas principais:**
- Soft Voting (RF+SVM+XGB+LGBM+KNN) atingiu 98.87% com 0 erros LOW/MEDIUM
- Knowledge distillation permite exportar como GNB mantendo qualidade do ensemble
- 25 features temporais ANOVA tem Cohen's d medio = 1.56 (top = 2.47)
