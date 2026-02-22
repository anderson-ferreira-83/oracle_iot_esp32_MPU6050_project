import json
import hashlib
from datetime import datetime, timezone


def utc_now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def load_json(path, default=None):
    if default is None:
        default = {}
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, data):
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)


def hash_file(path, algo='sha256', chunk_size=1024 * 1024):
    h = hashlib.new(algo)
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(chunk_size), b''):
            h.update(chunk)
    return h.hexdigest()


def append_registry(registry_path, entry, list_key='runs', keep_last=None):
    registry = load_json(registry_path, default={})
    runs = registry.get(list_key, [])
    runs.append(entry)
    if keep_last is not None and len(runs) > keep_last:
        runs = runs[-keep_last:]
    registry[list_key] = runs
    registry['updated_at'] = utc_now_iso()
    save_json(registry_path, registry)
    return registry
