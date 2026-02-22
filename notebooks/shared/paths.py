from dataclasses import dataclass
from pathlib import Path


@dataclass
class ProjectPaths:
    base_dir: Path
    output_dir: Path
    output_data: Path
    output_figures: Path
    output_metrics: Path
    output_models: Path
    config_dir: Path


def get_paths(base_dir=None, ensure=True):
    """Resolve paths relative to current working directory.

    When running from notebooks/, outputs stay in notebooks/output.
    config_dir prefers ../config if it exists, else ./config.
    """
    base = Path(base_dir) if base_dir else Path.cwd()
    output_dir = base / 'output'

    config_dir = (base.parent / 'config') if (base.parent / 'config').exists() else (base / 'config')

    paths = ProjectPaths(
        base_dir=base,
        output_dir=output_dir,
        output_data=output_dir / 'data',
        output_figures=output_dir / 'figures',
        output_metrics=output_dir / 'metrics',
        output_models=output_dir / 'models',
        config_dir=config_dir,
    )

    if ensure:
        for p in [paths.output_data, paths.output_figures, paths.output_metrics, paths.output_models, paths.config_dir]:
            p.mkdir(parents=True, exist_ok=True)

    return paths
