# Guia Didático (Estado Atual + Rotina Diária)

Este documento descreve o estágio atual do dashboard (ML em tempo real), como interpretar os **testes** (Transição e Soak) e qual é o fluxo recomendado para **melhorar a classificação do modelo diariamente** sem cair em armadilhas do “aprendizado com novos dados”.

## 1) Visão Geral do Que Existe Hoje

O que existe hoje, na prática:

- **Dashboard em tempo real** (`web/index.html` + `web/js/dashboard.js`): lê dados do backend, roda o classificador no navegador, mostra `LOW/MEDIUM/HIGH` e métricas.
- **Modelo ML (Base vs Adaptado)**: o Base é o “original”; o Adaptado é ajustado por sessões do Soak e fica salvo no `localStorage` (pode resetar).
- **Testes na Dash**: Transição (tempo de detecção por mudança) e Soak (estabilidade + sessão rotulada para OL).
- **Logs**: os testes salvam JSON em `logs/` via `api/log_transition`; logs são a base para rastreabilidade e comparação diária.

## 2) Card “Desempenho do Modelo” (Como Ler)

O card foi redesenhado para ficar curto e legível:

- **Grid (4 tiles)**: `CV(5f)`, `Train`, `Holdout`, `L↔M Err`.
- **Linha compacta de contexto**: número de features, número de janelas e validação.
- **Aprendizado Online** (`<details>`): sessões absorvidas, reset/export, e um painel “Sessão Soak” com atalho para o Soak.
- **Rastreabilidade e Features** (`<details>`): resumo do modelo/seleção e detalhes em tooltip.

Importante (limitação estrutural):

- **CV/Holdout/Train não se atualizam automaticamente após adaptação** (são métricas do treino offline).
- Para “provar ganho” pós-adaptação: avalie em conjunto novo e rotulado, ou logue janelas/features para medir depois (offline).

## 3) Teste Guiado de Transição (O Que Mudou e Como Usar)

Objetivo:

- Medir **tempo de detecção** do classificador após o comando “MUDE PARA X”.
- Diagnosticar assimetrias (subir vs descer velocidade) e atrasos.

Configurações (no card):

- **Estabilização (s)**: tempo inicial para você colocar o fan em `LOW` e estabilizar.
- **Espera Inicial (s)** (novo): tempo máximo adicional para o classificador reconhecer `LOW`.
- Se exceder, o teste continua e marca o início como **FORÇADO** (para manter o teste finito).
- **Timeout (s)**: limite de detecção para cada transição (marca `TIMEOUT`).
- **Confirmação (s)**: quanto tempo o estado alvo precisa permanecer estável para “confirmar”.
- **Preparação (s)**: countdown antes do “MUDE AGORA”.
- **Tag/Observações**: rastreabilidade (use sempre em rotina diária).

Visualização “tempos finitos” (melhoria solicitada):

- A barra global mostra `Inicio`, `Fim` e `Prev max` (pior caso).
- A lista de resultados mostra **todas as etapas (1 a 7)** e o intervalo **início→fim** de cada etapa.
- A etapa #1 (LOW inicial) agora aparece; se não for confirmada dentro de `Espera Inicial (s)`, aparece `FORÇADO(...)`.

Onde isso aparece no log:

- O payload inclui `test_started`, `test_ended`, `test_duration_s`, `test_config.initial_wait_s` e `results_all` (inclui a etapa inicial e flags como `forced`).

Interpretação prática:

- **Muitas etapas com TIMEOUT**: classificador não convergiu; revise amostragem, ruído, janela/features.
- **FORÇADO no início**: o classificador não reconheceu LOW a tempo; isso é sintoma (ou do ambiente, ou do gate/histerese, ou de drift).
- Use a **Comparação com Baseline** (quando disponível) para ver assimetria e convergência.

## 4) Teste de Estabilidade (Soak) (Timeout e Logs)

Objetivo:

- Medir estabilidade do classificador por estado mantendo o fan parado em cada velocidade.
- Gerar estatísticas por classe (features, flips, entropia, confiança).
- Produzir uma sessão “rotulada” (por intenção) para possível **Aprendizado Online**.

Configurações:

- **Sequência**: ex `LOW,MEDIUM,HIGH`
- **Hold (s)**: tempo de coleta por estado (depois do settle)
- **Settle (s)**: tempo descartado após confirmar (para evitar transiente)
- **Max espera alvo (s)** (novo): tempo máximo aguardando o classificador reconhecer o alvo.
- Se não reconhecer, o teste **não fica preso**: ele inicia `settle/hold` mesmo assim e marca **TIMEOUT**.
- **Preparação (s)**: countdown entre etapas
- **Tag/Observações**

Visualização:

- Linha global `Inicio | Fim | Prev max`
- Por etapa: `Acerto (%)` no alvo.
- Por etapa: `flips/min` (instabilidade).
- Por etapa: `T->alvo` (tempo até reconhecer o alvo) ou `TIMEOUT(...)`.
- Em `Settle/Hold`, quando houve timeout, a fase mostra `TIMEOUT: alvo não confirmado`.

Onde isso aparece no log:

- Cada segmento inclui `time_to_target_s` (quando houve reconhecimento).
- Se houve TIMEOUT, cada segmento inclui `wait_timeout_triggered`, `wait_timeout_s`, `wait_elapsed_s`, `wait_timeout_at`.
- Cada segmento inclui `feature_stats` por feature (média/desvio) e contagens `confirmed_counts/raw_counts`, `flips`, `flip_pairs`.

## 5) Aprendizado Online (Como Funciona Hoje)

O fluxo “com novos dados” foi implementado com guard-rails:

1. Você roda o **Soak Test** e o sistema gera `segments`.
2. O painel de absorção aparece no card do Soak (fluxo principal).
3. O card “Desempenho do Modelo” mostra um atalho/estado (“Sessão Soak”) para te levar até o Soak quando precisar.

Quality gate (por que existe):

- Sem rótulos confiáveis, adaptação é arriscada.
- Mesmo com rótulos, uma sessão ruim (poucas amostras, baixa separação, instabilidade) tende a piorar o modelo.

Comportamento:

- Sessão **OK**: absorção habilitada direto.
- Sessão **WARN**: exige confirmar “os rótulos estão corretos” para habilitar absorção.
- Sessão **BLOCK**: não deixa absorver (dados insuficientes).

Persistência:

- Modelo adaptado e histórico são salvos no `localStorage`.
- Reset limpa modelo adaptado e histórico.

## 6) Rotina Diária Recomendada (Para Melhorar a Classificação)

Objetivo da rotina:

- Melhorar o modelo sem “autoengano” (métrica offline não muda) e sem drift por rótulo ruim.

Passo a passo sugerido:

1. **Padronize o protocolo**
Protocolo: mesma posição do sensor, mesma fixação, mesmo ambiente quando possível. Tag: use `Tag` no Soak e no Transição (ex: `20Hz_dia_2026-02-08`).

2. **Rode o Soak**
Config: ajuste `Hold` para ter dados suficientes (ex: 180s por estado) e use `Max espera alvo (s)` para evitar travar. Validação: `Acerto` por estado (alvo domina), `flips/min` baixo, e `T->alvo` coerente (sem TIMEOUT frequente).

3. **(Opcional) Preview + Absorver**
Regra: só absorva quando você confia que os rótulos (LOW/MEDIUM/HIGH) estavam corretos. Se aparecer `WARN`, absorver só após confirmar rótulos. Se `BLOCK`, aumente `Hold` e rode novamente.

4. **Rode o Teste Guiado de Transição**
Cheque tempos por direção e assimetria (subida vs descida). Observe a etapa #1: `FORÇADO` repetido indica que o classificador não está “entrando” em LOW de forma confiável.

5. **Compare usando logs (não só CV/Holdout)**
As métricas do card do modelo (CV/Train/Holdout) são do treino offline. A evolução diária deve ser comparada pelos logs do Soak/Transição, com o mesmo protocolo.

## 7) Onde Ficam os Logs e Como Usar

- Logs ficam em `logs/` com nome como `ml_transitions_YYYYMMDD_HHMMSS_f_XX.json`.
- Cada arquivo é uma lista de entradas; as mais úteis são `type: "transition_test"` e `type: "stability_test"`.
- No dashboard, use o seletor “Log Selecionado” para abrir e ver o resumo.

Sugestão de disciplina:

1. 1 arquivo por “sessão diária” (use `action=new` automaticamente via botão Iniciar Teste).
2. Sempre preencher `Tag` e `Observações`.
3. Ao final do dia, guarde o arquivo de log (ele é seu histórico de performance real).

## 8) Limitações e Alertas (Importantes)

1. **Sem rótulos confiáveis, Online Learning pode piorar o modelo.**
2. **Ganhos reais precisam de avaliação rotulada nova** (ou um protocolo fixo de testes para comparar logs).
3. TIMEOUT/FORÇADO não são “erros do teste”; são sinais diagnósticos para orientar ajustes: amostragem, features, janela, smoothing/histerese, fixação mecânica, ruído e drift.
