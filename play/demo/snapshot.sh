#!/usr/bin/env bash
# Snapshot the GET answers the web demo needs from a running local stack
# (draft-service on :18382, ai-service on :18383) into play/demo/static/demo-api.
# Run from anywhere: bash play/demo/snapshot.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
api="http://127.0.0.1:${DRAFT_API_PORT:-18382}"
ai="http://127.0.0.1:${AI_SERVICE_PORT:-18383}"
out="$here/static/demo-api"
rm -rf "$out"
mkdir -p "$out/api/creatures" "$out/api/generate" "$out/ai" "$out/vlm"
get() { curl -fsS -m 30 "$1" -o "$2"; }
get "$api/api/catalog" "$out/api/catalog.json"
get "$api/api/bodies" "$out/api/bodies.json"
get "$api/api/flower-status" "$out/api/flower-status.json"
get "$api/api/training-status" "$out/api/training-status.json"
get "$api/api/training/jobs/current" "$out/api/training-current.json" || echo '{"job":null}' > "$out/api/training-current.json"
get "$ai/health" "$out/ai/health.json"
cp "$out/ai/health.json" "$out/vlm/health.json"
# Keep only bodies whose files are committed under creatures/ (runtime-generated
# bodies live in draft-service/.bodies and are not part of the demo).
python3 - "$out/api/bodies.json" "$here/../../creatures" <<'PY'
import json, os, sys
path, creatures = sys.argv[1], sys.argv[2]
data = json.load(open(path))
data['bodies'] = [b for b in data['bodies'] if os.path.isdir(os.path.join(creatures, b['id']))]
json.dump(data, open(path, 'w'))
PY
ids=$(python3 -c 'import json,sys; print(" ".join(b["id"] for b in json.load(open(sys.argv[1]))["bodies"]))' "$out/api/bodies.json")
for id in $ids; do
  mkdir -p "$out/api/creatures/$id"
  get "$api/api/creatures/$id/policies" "$out/api/creatures/$id/policies.json"
done
# Legacy presets: POST /api/generate {preset} at scale 1 answers with the
# manifest that already ships in public/draft/<preset>-<hash>/manifest.json.
for dir in "$here"/../public/draft/*/; do
  preset=$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); p=m.get("parameters",{}); print(m["preset"] if p.get("lengthScale",1)==1 and p.get("legScale",1)==1 else "")' "$dir/manifest.json")
  if [ -n "$preset" ]; then cp "$dir/manifest.json" "$out/api/generate/$preset.json"; fi
done
find "$out" -type f | sort
