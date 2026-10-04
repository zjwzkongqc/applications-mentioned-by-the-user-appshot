#!/usr/bin/env bash
set -euo pipefail
umask 077

deploy_china_release() (
  set -euo pipefail
  local base=$1 hostname=$2 release=$3 checksum=$4 run_id=$5
  [[ "$hostname" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$ && "$hostname" != *..* && "$hostname" != *.-* && "$hostname" != *-.* ]]
  [[ "$release" =~ ^[a-f0-9]{40}$ && "$checksum" =~ ^[a-f0-9]{64}$ && "$run_id" =~ ^[0-9]{1,20}$ ]]
  install -d -m 700 "$base/releases" "$base/incoming"
  exec 9>"$base/.deploy.lock"
  flock --wait 90 9
  local archive="$base/incoming/$release-$run_id.tar.gz" candidate previous='' activated=0
  candidate=$(mktemp -d "$base/releases/$release-$run_id-XXXXXXXX")
  if [[ -L "$base/current" ]]; then
    previous=$(readlink -e "$base/current")
    [[ "$previous" == "$base/releases/"* && -f "$previous/.env" ]]
  elif [[ -e "$base/current" ]]; then
    echo 'The current release path is not a managed symlink.' >&2; exit 1
  fi
  rollback() {
    local status=$?
    if [[ "$status" != 0 && "$activated" == 1 && -n "$previous" ]]; then
      (cd "$previous" && docker compose up --detach --wait --wait-timeout 90) >>"$base/incoming/rollback-$run_id.log" 2>&1 || true
    fi
    if [[ "$status" != 0 ]]; then echo 'Candidate deployment failed; the committed configuration was retained. Inspect the private server log.' >&2; fi
    return "$status"
  }
  trap rollback EXIT
  python3 - "$archive" "$checksum" "$candidate" "$release" <<'PY'
import hashlib, os, sys, tarfile
archive, checksum, target, release = sys.argv[1:]
digest=hashlib.sha256()
with open(archive,'rb') as f:
    for block in iter(lambda:f.read(1024*1024),b''): digest.update(block)
if digest.hexdigest()!=checksum: raise SystemExit('Package checksum mismatch.')
allowed={'compose.yaml','Caddyfile','install.sh','RELEASE','SHA256SUMS','images.tar.gz'}
with tarfile.open(archive,'r:gz') as tar:
    entries=tar.getmembers()
    if len(entries)!=len(allowed) or {x.name for x in entries}!=allowed or any(not x.isfile() or x.size<0 or x.size>600*1024*1024 for x in entries):
        raise SystemExit('Unsafe or incomplete package.')
    if tar.extractfile('RELEASE').read()!= (release+'\n').encode(): raise SystemExit('Package release mismatch.')
    lines=tar.extractfile('SHA256SUMS').read(4096).decode().splitlines()
    expected=allowed-{'SHA256SUMS'}
    names=[]
    for line in lines:
        parts=line.split('  ')
        if len(parts)!=2 or len(parts[0])!=64 or any(c not in '0123456789abcdef' for c in parts[0]) or parts[1] not in expected:
            raise SystemExit('Invalid inner checksum list.')
        names.append(parts[1])
    if len(names)!=len(expected) or set(names)!=expected: raise SystemExit('Incomplete inner checksum list.')
    for item in entries:
        with open(os.path.join(target,item.name),'xb') as out, tar.extractfile(item) as src:
            while True:
                block=src.read(1024*1024)
                if not block: break
                out.write(block)
PY
  (cd "$candidate" && sha256sum --check SHA256SUMS) >"$base/incoming/deploy-$run_id.log" 2>&1
  if [[ -n "$previous" ]]; then
    python3 - "$previous/.env" "$hostname" <<'PY'
import re, sys
lines=open(sys.argv[1]).read().splitlines()
data={}
for line in lines:
    if '=' not in line: raise SystemExit('Invalid current configuration.')
    key,value=line.split('=',1)
    if key in data: raise SystemExit('Duplicate current configuration.')
    data[key]=value
if set(data)!={'TENNIS_HOSTNAME','TENNIS_RELEASE','MAINTENANCE_MODE'} or data['TENNIS_HOSTNAME']!=sys.argv[2] or not re.fullmatch('[a-f0-9]{40}',data['TENNIS_RELEASE']) or data['MAINTENANCE_MODE'] not in {'0','1'}:
    raise SystemExit('Current configuration or hostname does not match.')
PY
    cp -- "$previous/.env" "$candidate/.env"
  fi
  activated=1
  (cd "$candidate" && bash install.sh "$hostname") >>"$base/incoming/deploy-$run_id.log" 2>&1
  local healthy=0 health_file="$base/incoming/health-$run_id.json" headers_file="$base/incoming/headers-$run_id.txt"
  for attempt in {1..6}; do
    if curl --fail --silent --show-error --max-time 10 --dump-header "$headers_file" "https://$hostname/healthz" >"$health_file" 2>>"$base/incoming/deploy-$run_id.log" && python3 - "$health_file" "$headers_file" "$release" "$candidate/.env" <<'PY'
import json, sys
body=json.load(open(sys.argv[1]))
headers=open(sys.argv[2]).read().splitlines()
settings=dict(line.strip().split('=',1) for line in open(sys.argv[4]) if line.strip())
version=[line.split(':',1)[1].strip() for line in headers if line.lower().startswith('x-tennis-release:')]
if body.get('ok') is not True or body.get('maintenance') is not (settings['MAINTENANCE_MODE']=='1') or version!=[sys.argv[3]]: raise SystemExit(1)
PY
    then healthy=1; break; fi
    sleep 5
  done
  [[ "$healthy" == 1 ]] || { echo 'HTTPS release verification failed.' >&2; exit 1; }
  ln -s "$candidate" "$base/.current-$run_id"
  mv -Tf "$base/.current-$run_id" "$base/current"
  local mode
  mode=$(grep '^MAINTENANCE_MODE=' "$candidate/.env" | cut -d= -f2)
  [[ "$mode" == 1 ]] && printf 'CHINA_DEPLOY_RESULT {"deployed":true,"maintenance":true}\n' || printf 'CHINA_DEPLOY_RESULT {"deployed":true,"maintenance":false}\n'
)

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]:-}" == "$0" ]]; then
  [[ "$#" == 4 ]] || { echo 'Explicit domain, release, checksum and run identifier are required.' >&2; exit 1; }
  deploy_china_release /opt/tennis-deploy "$@"
fi
