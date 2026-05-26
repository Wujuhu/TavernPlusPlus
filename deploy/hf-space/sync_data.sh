#!/bin/bash
set -eu

TK="${HF_TOKEN:-}"
DS="${DATASET_ID:-}"
DD="${DATA_ROOT:-/app/data-headless}"
TD="/tmp/backup"

mkdir -p "$TD" "$DD" 2>/dev/null || true
chmod 777 "$TD" "$DD" 2>/dev/null || true

if [ -z "$TK" ] || [ -z "$DS" ]; then
  echo "[sync] HF_TOKEN or DATASET_ID not set, skipping"
  exit 0
fi

echo "[sync] Starting: dataset=$DS dataDir=$DD interval=${SYNC_INTERVAL:-3600}s"

PY='
import os, tarfile, tempfile, time, traceback
from huggingface_hub import HfApi, hf_hub_download

T  = os.environ["TK"]
R  = os.environ["DS"]
D  = os.environ["DD"]
P  = "data_"
KEEP = int(os.environ.get("KEEP", "10"))

api = HfApi(token=T)

def list_snapshots():
    return sorted(
        f for f in api.list_repo_files(repo_id=R, repo_type="dataset")
        if f.startswith(P) and f.endswith(".tgz")
    )

def upload_snapshot(local_path, filename):
    api.upload_file(
        path_or_fileobj=local_path,
        path_in_repo=filename,
        repo_id=R,
        repo_type="dataset",
    )
    print(f"[sync] uploaded: {filename}")
    fs = list_snapshots()
    for f in fs[:-KEEP]:
        try:
            api.delete_file(path_in_repo=f, repo_id=R, repo_type="dataset")
            print(f"[sync] cleaned old snapshot: {f}")
        except Exception:
            pass
    fs2 = list_snapshots()
    latest = fs2[-1] if fs2 else "none"
    print(f"[sync] remote snapshots: {len(fs2)} (keep={KEEP}), latest: {latest}")

def download_latest():
    fs = list_snapshots()
    if not fs:
        print("[sync] no remote snapshots, skip initial download")
        return
    latest = fs[-1]
    with tempfile.TemporaryDirectory() as td:
        fp = hf_hub_download(repo_id=R, filename=latest, repo_type="dataset", local_dir=td)
        os.makedirs(D, exist_ok=True)
        with tarfile.open(fp, "r:gz") as t:
            t.extractall(D)
    print(f"[sync] restored from: {latest}")

try:
    download_latest()
except Exception:
    print("[sync] initial download failed:")
    traceback.print_exc()

while True:
    try:
        if os.path.isdir(D) and os.listdir(D):
            fn = P + time.strftime("%Y%m%d%H%M%S") + ".tgz"
            fp = os.path.join("/tmp/backup", fn)
            with tarfile.open(fp, "w:gz") as t:
                t.add(D, arcname=".")
            upload_snapshot(fp, fn)
            os.remove(fp)
        else:
            print("[sync] data dir empty, skip upload")
    except Exception:
        print("[sync] upload error:")
        traceback.print_exc()

    time.sleep(int(os.environ.get("SI", "3600")))
'

export HF_HUB_DISABLE_PROGRESS_BARS=1
export PYTHONUNBUFFERED=1
export TK="$TK" DS="$DS" DD="$DD" SI="${SYNC_INTERVAL:-3600}"
exec python3 -u -c "$PY"
