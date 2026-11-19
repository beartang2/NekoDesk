#!/bin/sh
# 아이폰 앱 다시 설치. 무료 Apple 계정으로 서명한 앱은 7일 뒤 안 열린다(데이터는 남는다) — 그 전에 덮어 설치한다.
# release 브랜치의 최신 코드로 빌드한다: 맥을 배포한 뒤 다음 재설치 때 폰도 같은 버전이 된다. docs/neko-sync.md §6.5·§12
#   scripts/ios-reinstall.sh           만료까지 3일 넘게 남았으면 아무것도 안 한다
#   scripts/ios-reinstall.sh --force   남은 날과 상관없이 다시 설치
#   scripts/ios-reinstall.sh --days    남은 날만 알려 준다
# 폰을 케이블로 연결하고 잠금을 풀어 둔 채 돌린다.
# ponytail: 손으로 돌린다. launchd 로 날마다 돌리기는 폰이 연결돼 있어야 하고 설치 전에 알릴 길이 없어 아직 안 만들었다.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# release 를 받아 빌드하는 작업 폴더(git worktree). 작업 중인 브랜치를 건드리지 않게 따로 둔다
WORK="${NEKO_IOS_RELEASE_DIR:-$(dirname "$ROOT")/NekoDesk-ios-release}"
IPA_REL="src-tauri/gen/apple/build/arm64/NekoDesk.ipa"

# 마지막으로 만든 앱의 서명이 며칠 남았나(만든 적 없으면 0)
days_left() {
  for ipa in "$WORK/$IPA_REL" "$ROOT/$IPA_REL"; do
    [ -f "$ipa" ] || continue
    exp=$(unzip -p "$ipa" 'Payload/*.app/embedded.mobileprovision' 2>/dev/null | security cms -D 2>/dev/null | plutil -extract ExpirationDate raw - 2>/dev/null) || continue
    end=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$exp" +%s 2>/dev/null) || continue
    echo $(( (end - $(date +%s)) / 86400 ))
    return
  done
  echo 0
}

LEFT=$(days_left)
case "${1:-}" in
  --days) echo "$LEFT"; exit 0 ;;
  --force) ;;
  "") [ "$LEFT" -le 3 ] || { echo "서명이 ${LEFT}일 남았어. 아직 다시 설치하지 않아도 돼(--force 로 지금)."; exit 0; } ;;
  *) echo "모르는 옵션: $1" >&2; exit 2 ;;
esac

git -C "$ROOT" fetch --quiet origin release
git -C "$ROOT" cat-file -e origin/release:src-tauri/gen/apple/project.yml 2>/dev/null || {
  echo "release 브랜치에 아직 아이폰 빌드 설정이 없어(0.1.16 부터). 그 전에는 scripts/ios-install.sh 로 이 폴더의 코드를 설치해." >&2
  exit 1
}
if [ -d "$WORK" ]; then
  git -C "$WORK" checkout --quiet -- src-tauri/gen/apple/nekodesk.xcodeproj 2>/dev/null || true
  git -C "$WORK" checkout --quiet --detach origin/release
else
  git -C "$ROOT" worktree add --quiet --detach "$WORK" origin/release
fi
# 서명 팀 ID 는 git 밖에 있다
[ -f "$WORK/src-tauri/gen/apple/.team" ] || cp "$ROOT/src-tauri/gen/apple/.team" "$WORK/src-tauri/gen/apple/.team"
cd "$WORK"
# 의존성은 잠금 파일이 바뀌었을 때만 다시 받는다
cmp -s package-lock.json node_modules/.neko-lock 2>/dev/null || { npm ci --no-audit --no-fund && cp package-lock.json node_modules/.neko-lock; }
echo "release $(git rev-parse --short HEAD) 를 빌드해 연결된 아이폰에 설치한다."
# 빌드 산출물은 이 폴더(외장 디스크)의 것을 같이 써서 처음부터 다시 빌드하지 않는다
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}" scripts/ios-install.sh
