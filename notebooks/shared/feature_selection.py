from itertools import combinations

import numpy as np
import pandas as pd
from scipy import stats as scipy_stats

from shared.class_config import CLASS_ORDER


def cohens_d(group1, group2):
    """Cohen's d (absolute) between two 1D groups.

    Uses pooled standard deviation (sample variance, ddof=1), aligned with
    common statistical definition. Returns 0.0 when insufficient data or when
    pooled std is ~0.
    """
    g1 = pd.Series(group1).dropna().astype(float).values
    g2 = pd.Series(group2).dropna().astype(float).values
    n1 = int(g1.size)
    n2 = int(g2.size)
    if n1 < 2 or n2 < 2:
        return 0.0

    # Sample variances (ddof=1)
    v1 = float(np.var(g1, ddof=1))
    v2 = float(np.var(g2, ddof=1))
    pooled = ((n1 - 1) * v1 + (n2 - 1) * v2) / max((n1 + n2 - 2), 1)
    pooled_std = float(np.sqrt(max(pooled, 0.0)))
    if pooled_std < 1e-12:
        return 0.0

    return float(abs(np.mean(g1) - np.mean(g2)) / pooled_std)


def select_features_cohens_d_classwise_corr_pairwise_score_topk(
    df_features,
    feature_cols,
    class_col='fan_state',
    classes=None,
    correlation_threshold=0.85,
    correlation_mode='classwise_median',
    pairwise_min_separation=0.7,
    pairwise_min_pairs=2,
    min_cohens_d=None,
    score_mode='d_min_adjacent',
    top_k=10,
    verbose=False,
):
    """Feature selection using Cohen's d + classwise correlation + pairwise filter + TOP-K.

    Motivation: directly optimize separability between adjacent classes (LOW/MEDIUM and MEDIUM/HIGH),
    which is critical to reduce LOW<->MEDIUM oscillation in runtime.

    Returns: (selected_features, df_scores, df_sep)
    - df_sep: d scores per feature (d_LOW_MEDIUM, d_MEDIUM_HIGH, d_LOW_HIGH, d_min_adjacent, ...)
    - df_scores: final candidates with filters and score used for TOP-K selection
    """
    classes = classes or CLASS_ORDER
    if len(classes) < 2:
        raise ValueError('classes must have at least 2 entries')

    # Cohen's d for all pairs
    class_pairs = list(combinations(classes, 2))

    sep_results = []
    for feat in feature_cols:
        row = {'feature': feat}
        for a, b in class_pairs:
            g1 = df_features[df_features[class_col] == a][feat]
            g2 = df_features[df_features[class_col] == b][feat]
            row[f'd_{a}_{b}'] = cohens_d(g1, g2)
        dvals = [row[f'd_{a}_{b}'] for a, b in class_pairs]
        row['d_min_all'] = float(min(dvals)) if dvals else 0.0
        row['d_min_adjacent'] = row['d_min_all']
        sep_results.append(row)

    df_sep = pd.DataFrame(sep_results)
    if df_sep.empty:
        return [], pd.DataFrame(), df_sep

    sort_col = 'd_min_adjacent' if score_mode == 'd_min_adjacent' else 'd_min_all'
    if score_mode not in ('d_min_adjacent', 'd_min_all'):
        sort_col = 'd_min_adjacent'

    df_sep = df_sep.sort_values(sort_col, ascending=False).reset_index(drop=True)

    if verbose:
        print(f"Cohen's d ranking (top 15, {len(class_pairs)} pares):")
        cols_show = ['feature', 'd_min_all']
        # Show individual pair columns if not too many
        if len(class_pairs) <= 6:
            cols_show = ['feature'] + [f'd_{a}_{b}' for a, b in class_pairs] + ['d_min_all']
        print(df_sep[cols_show].head(15).to_string(index=False))
        print()

    # Optional threshold filter on the chosen score column
    df_candidates = df_sep.copy()
    relaxed_min_d = False
    if min_cohens_d is not None:
        df_pass = df_candidates[df_candidates[sort_col] >= float(min_cohens_d)].copy()
        if len(df_pass) >= int(top_k) and int(top_k) > 0:
            df_candidates = df_pass
        else:
            # Fallback: keep ranking but relax the threshold to avoid selecting 0 features.
            relaxed_min_d = True
            if verbose:
                print(f'AVISO: poucos candidatos com {sort_col} >= {min_cohens_d} ({len(df_pass)}). Relaxando criterio para TOP-K por ranking.')
            df_candidates = df_sep.copy()
        if verbose and not relaxed_min_d:
            print(f'Candidates with {sort_col} >= {min_cohens_d}: {len(df_candidates)}')

    # Correlation filter (classwise median/mean), keeping the feature with higher separation score
    selected_after_corr = df_candidates['feature'].tolist()
    if selected_after_corr:
        corr_mats = []
        for cls in classes:
            df_cls = df_features[df_features[class_col] == cls][selected_after_corr]
            if len(df_cls) < 2:
                continue  # skip classes with insufficient data for correlation
            corr = df_cls.corr().abs().fillna(0.0)
            corr_mats.append(corr.values)

        if corr_mats:
            if correlation_mode == 'classwise_median':
                corr_matrix = np.median(np.stack(corr_mats, axis=0), axis=0)
            else:
                corr_matrix = np.mean(np.stack(corr_mats, axis=0), axis=0)

            corr_subset = pd.DataFrame(corr_matrix, index=selected_after_corr, columns=selected_after_corr)
            upper = corr_subset.where(np.triu(np.ones(corr_subset.shape), k=1).astype(bool))

            score_map = dict(zip(df_candidates['feature'], df_candidates[sort_col]))
            to_remove = set()
            for col in upper.columns:
                correlated = upper.index[upper[col] > correlation_threshold].tolist()
                for corr_feat in correlated:
                    s_col = score_map.get(col, 0.0)
                    s_corr = score_map.get(corr_feat, 0.0)
                    # Remove the weaker one (lower separability)
                    if s_corr < s_col:
                        to_remove.add(corr_feat)
                    else:
                        to_remove.add(col)

            selected_after_corr = [f for f in selected_after_corr if f not in to_remove]
            if verbose:
                print(f'Removidas por correlacao > {correlation_threshold}: {len(to_remove)}')
                print(f'Apos correlacao: {len(selected_after_corr)}')
                print()
        else:
            if verbose:
                print('Sem dados suficientes para calcular correlacao por classe.')
                print()

    # Pairwise filter + score for TOP-K
    rows = []
    for feat in selected_after_corr:
        row = df_sep[df_sep['feature'] == feat].iloc[0].to_dict()
        # Count how many class-pairs pass the separation threshold
        d_cols = [c for c in row.keys() if c.startswith('d_') and c != 'd_min_adjacent' and c != 'd_min_all']
        passed = 0
        for c in d_cols:
            try:
                if float(row[c]) >= float(pairwise_min_separation):
                    passed += 1
            except Exception:
                pass
        row['pairs_passed'] = int(passed)

        # Score selection
        if score_mode == 'd_min_all':
            row['score'] = float(row.get('d_min_all', 0.0))
        else:
            row['score'] = float(row.get('d_min_adjacent', row.get('d_min_all', 0.0)))
        rows.append(row)

    if rows:
        df_scores = pd.DataFrame(rows).sort_values('score', ascending=False)
        df_scores_pass = df_scores[df_scores['pairs_passed'] >= int(pairwise_min_pairs)].copy()
        if df_scores_pass.empty and not df_scores.empty:
            if verbose:
                print('AVISO: nenhum candidato passou no filtro pairwise. Relaxando criterio e usando TOP-K por score.')
            df_scores_pass = df_scores.copy()
    else:
        df_scores = pd.DataFrame()
        df_scores_pass = df_scores

    selected_features = df_scores_pass['feature'].head(int(top_k)).tolist() if not df_scores_pass.empty else []

    if verbose:
        print(f'--- Filtro pairwise (min={pairwise_min_separation}, pares>={pairwise_min_pairs}) ---')
        if not df_scores.empty:
            show_cols = ['feature', 'score', 'pairs_passed', 'd_min_all']
            print(df_scores[show_cols].head(20).to_string(index=False))
        print()
        print(f'Selecionadas TOP-K (K={top_k}): {len(selected_features)}')
        for i, f in enumerate(selected_features, 1):
            print(f'  {i:02d}. {f}')
        print()

    return selected_features, df_scores, df_sep


def select_features_anova_classwise_corr_pairwise_score_topk(
    df_features,
    feature_cols,
    class_col='fan_state',
    classes=None,
    anova_alpha=0.05,
    correlation_threshold=0.85,
    correlation_mode='classwise_median',
    pairwise_min_separation=0.7,
    pairwise_min_pairs=2,
    top_k=10,
    verbose=False,
):
    classes = classes or CLASS_ORDER
    class_pairs = list(combinations(classes, 2))

    # 1) ANOVA
    anova_results = []
    for feat in feature_cols:
        groups = [df_features[df_features[class_col] == cls][feat].dropna().values for cls in classes]
        # Filter out classes with insufficient data (< 2 samples)
        groups = [g for g in groups if len(g) > 1]
        if len(groups) >= 2:
            f_stat, p_val = scipy_stats.f_oneway(*groups)
            anova_results.append({'feature': feat, 'f_statistic': f_stat, 'p_value': p_val})

    df_anova = pd.DataFrame(anova_results)
    if not df_anova.empty:
        df_anova = df_anova.sort_values('f_statistic', ascending=False).reset_index(drop=True)

    df_significant = pd.DataFrame()
    significant_features = []
    if not df_anova.empty:
        df_significant = df_anova[df_anova['p_value'] < anova_alpha].copy()
        significant_features = df_significant['feature'].tolist()

    if verbose:
        print(f'Features significativas (p < {anova_alpha}): {len(df_significant)} de {len(df_anova)}')

    # 2) Correlacao por classe (mediana)
    if significant_features:
        corr_mats = []
        for cls in classes:
            df_cls = df_features[df_features[class_col] == cls][significant_features]
            if len(df_cls) < 2:
                continue  # skip classes with insufficient data for correlation
            corr = df_cls.corr().abs().fillna(0.0)
            corr_mats.append(corr.values)

        if corr_mats:
            if correlation_mode == 'classwise_median':
                corr_matrix = np.median(np.stack(corr_mats, axis=0), axis=0)
            else:
                corr_matrix = np.mean(np.stack(corr_mats, axis=0), axis=0)

            corr_subset = pd.DataFrame(corr_matrix, index=significant_features, columns=significant_features)
            upper = corr_subset.where(np.triu(np.ones(corr_subset.shape), k=1).astype(bool))

            f_map = dict(zip(df_significant['feature'], df_significant['f_statistic']))
            to_remove = set()
            for col in upper.columns:
                correlated = upper.index[upper[col] > correlation_threshold].tolist()
                for corr_feat in correlated:
                    f_col = f_map.get(col, 0)
                    f_corr = f_map.get(corr_feat, 0)
                    if f_corr < f_col:
                        to_remove.add(corr_feat)
                    else:
                        to_remove.add(col)

            after_corr = [f for f in significant_features if f not in to_remove]
            if verbose:
                print(f'Removidas por correlacao (mediana por classe) > {correlation_threshold}: {len(to_remove)}')
                print(f'Apos filtro de correlacao: {len(after_corr)} features')
        else:
            after_corr = significant_features
            if verbose:
                print('Sem dados suficientes para calcular correlacao por classe.')
    else:
        after_corr = []
        if verbose:
            print('Nenhuma feature significativa para aplicar filtro de correlacao.')

    # 3) Pairwise + score
    pairwise_rows = []
    if verbose:
        print()
        print(f'--- Filtro de Separacao Pairwise (min={pairwise_min_separation}, pares>= {pairwise_min_pairs}) ---')

    for feat in after_corr:
        seps = []
        for cls_a, cls_b in class_pairs:
            vals_a = df_features[df_features[class_col] == cls_a][feat].values
            vals_b = df_features[df_features[class_col] == cls_b][feat].values
            if len(vals_a) == 0 or len(vals_b) == 0:
                sep = 0.0
            else:
                mean_a, mean_b = np.mean(vals_a), np.mean(vals_b)
                var_a, var_b = np.var(vals_a, ddof=0), np.var(vals_b, ddof=0)
                avg_var = (var_a + var_b) / 2
                sep = abs(mean_a - mean_b) / (np.sqrt(avg_var) + 1e-10)
            seps.append(sep)

        min_sep = float(np.min(seps)) if seps else 0.0
        pairs_passed = int(sum(s >= pairwise_min_separation for s in seps))
        worst_pair = class_pairs[int(np.argmin(seps))][0] + '-' + class_pairs[int(np.argmin(seps))][1]

        f_stat = df_significant[df_significant['feature'] == feat]['f_statistic'].values[0]
        p_val = df_significant[df_significant['feature'] == feat]['p_value'].values[0]
        score = min_sep * np.log1p(f_stat)

        pairwise_rows.append({
            'feature': feat,
            'min_sep': min_sep,
            'pairs_passed': pairs_passed,
            'worst_pair': worst_pair,
            'f_statistic': float(f_stat),
            'p_value': float(p_val),
            'score': float(score),
        })

        if verbose:
            status = 'OK ' if pairs_passed >= pairwise_min_pairs else 'DEL'
            print(f'  {status} {feat:42s} min_sep={min_sep:6.2f} pares={pairs_passed} F={f_stat:10.2f} score={score:8.2f}')

    if pairwise_rows:
        df_scores = pd.DataFrame(pairwise_rows).sort_values('score', ascending=False)
        df_scores_pass = df_scores[df_scores['pairs_passed'] >= pairwise_min_pairs]
    else:
        df_scores = pd.DataFrame(columns=['feature', 'min_sep', 'pairs_passed', 'worst_pair', 'f_statistic', 'p_value', 'score'])
        df_scores_pass = df_scores

    selected_features = df_scores_pass['feature'].head(top_k).tolist()

    if verbose:
        print()
        print(f'Candidatas aprovadas (pairwise >= {pairwise_min_pairs} pares): {len(df_scores_pass)}')
        print(f'Selecionadas TOP-K (K={top_k}): {len(selected_features)}')

        if selected_features:
            print()
            print('Features selecionadas FINAL:')
            for i, f in enumerate(selected_features, 1):
                row = df_scores_pass[df_scores_pass['feature'] == f].iloc[0]
                print(f'  {i:2d}. {f:40s} score={row["score"]:8.2f} min_sep={row["min_sep"]:5.2f} F={row["f_statistic"]:10.2f}  p={row["p_value"]:.2e}')
        else:
            print('Nenhuma feature selecionada.')

    return selected_features, df_scores, df_anova, df_significant
