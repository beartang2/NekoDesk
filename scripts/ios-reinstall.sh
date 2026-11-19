#!/bin/sh
# 아이폰 앱 다시 설치. 무료 Apple 계정으로 서명한 앱은 7일 뒤 안 열린다(데이터는 남는다) — 그 전에 덮어 설치한다.
# release 브랜치의 최신 코드로 빌드한다: 맥을 배포한 뒤 다음 재설치 때 폰도 같은 버전이 된다. docs/neko-sync.md §6.5·§12
#   scripts/ios-reinstall.sh           만료까지 3일 넘게 남았으면 아무것도 안 한다
#   scripts/ios-reinstall.sh --force   남은 날과 상관없이 다시 설치
#   scripts/ios-reinstall.sh --days    남은 날만 알려 준다
#   scripts/ios-reinstall.sh --auto    launchd 가 하루 한 번 부른다(scripts/ios-reinstall-agent.sh): 3일 넘게 남았으면 조용히 끝,
#                                      다시 설치했거나 못 했으면 맥 알림, 한 일은 로그 파일에
# 폰은 케이블이나 같은 Wi-Fi 로 맥에 보여야 하고 잠금이 풀려 있어야 한다.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# release 를 받아 빌드하는 작업 폴더(git worktree). 작업 중인 브랜치를 건드리지 않게 따로 둔다
WORK="${NEKO_IOS_RELEASE_DIR:-$(dirname "$ROOT")/NekoDesk-ios-release}"
IPA_REL="src-tauri/gen/apple/build/arm64/NekoDesk.ipa"
# --auto 가 한 일(돌 때마다 덮어쓴다). 외장 디스크에 둔다
LOG="$(dirname "$ROOT")/NekoDesk-ios-reinstall.log"
# 만료 시각(초)을 내장 디스크에도 적어 둔다 — 외장 디스크가 빠져 있을 때 에이전트가 며칠 남았는지 알게
STATE="$HOME/Library/Application Support/NekoDesk"

# 마지막으로 만든 앱의 서명이 끝나는 시각(초). 만든 적 없으면 0
expiry() {
  for ipa in "$WORK/$IPA_REL" "$ROOT/$IPA_REL"; do
    [ -f "$ipa" ] || continue
    exp=$(unzip -p "$ipa" 'Payload/*.app/embedded.mobileprovision' 2>/dev/null | security cms -D 2>/dev/null | plutil -extract ExpirationDate raw - 2>/dev/null) || continue
    date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$exp" +%s 2>/dev/null && return
  done
  echo 0
}
days_left() { echo $(( ($(expiry) - $(date +%s)) / 86400 )); }
remember() { mkdir -p "$STATE" && expiry > "$STATE/ios-expiry"; }

# 이 앱의 서명 프로파일(Xcode 가 받아 둔 것)을 지운다. 아직 안 끝난 프로파일이 있으면 Xcode 가 그걸 다시 써서,
# 다시 설치해도 만료일이 그대로일 수 있다 — 지우면 새로(7일) 받는다. 만료가 가까울 때만 한다(--force 로 자꾸 받지 않게).
fresh_profile() {
  for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision "$HOME/Library/MobileDevice/Provisioning Profiles"/*.mobileprovision; do
    [ -f "$f" ] || continue
    if security cms -D -i "$f" 2>/dev/null | grep -q '\.com\.nekodesk\.desktop</string>'; then rm -f "$f"; fi
  done
}

reinstall() {
  git -C "$ROOT" fetch --quiet origin release
  git -C "$ROOT" cat-file -e origin/release:src-tauri/gen/apple/project.yml 2>/dev/null || {
    echo "release 브랜치에 아직 아이폰 빌드 설정이 없어(0.1.16 부터). 그 전에는 scripts/ios-install.sh 로 이 폴더의 코드를 설치해." >&2
    return 1
  }
  if [ -d "$WORK" ]; then
    git -C "$WORK" checkout --quiet -- src-tauri/gen/apple/nekodesk.xcodeproj 2>/dev/null || true
    git -C "$WORK" checkout --quiet --detach origin/release
  else
    git -C "$ROOT" worktree add --quiet --detach "$WORK" origin/release
  fi
  # 서명 팀 ID 는 git 밖에 있다
  [ -f "$WORK/src-tauri/gen/apple/.team" ] || cp "$ROOT/src-tauri/gen/apple/.team" "$WORK/src-tauri/gen/apple/.team"
  if [ "$LEFT" -le 3 ]; then fresh_profile; fi
  cd "$WORK"
  # 의존성은 잠금 파일이 바뀌었을 때만 다시 받는다
  cmp -s package-lock.json node_modules/.neko-lock 2>/dev/null || { npm ci --no-audit --no-fund && cp package-lock.json node_modules/.neko-lock; }
  echo "release $(git rev-parse --short HEAD) 를 빌드해 연결된 아이폰에 설치한다."
  # 빌드 산출물은 이 폴더(외장 디스크)의 것을 같이 써서 처음부터 다시 빌드하지 않는다
  CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}" scripts/ios-install.sh
}

notify() {
  /usr/bin/osascript -e 'on run a' -e 'display notification (item 1 of a) with title "NekoDesk 아이폰 앱"' -e 'end run' "$1" >/dev/null 2>&1 || true
}

LEFT=$(days_left)
case "${1:-}" in
  --days) echo "$LEFT"; exit 0 ;;
  --force) reinstall; remember ;;
  "")
    [ "$LEFT" -le 3 ] || { echo "서명이 ${LEFT}일 남았어. 아직 다시 설치하지 않아도 돼(--force 로 지금)."; exit 0; }
    reinstall; remember ;;
  --auto)
    remember
    [ "$LEFT" -le 3 ] || exit 0
    # set -e 는 if 조건 안에서 꺼지니, 실패를 놓치지 않게 따로 돌려 끝 코드를 본다
    set +e
    (set -e; reinstall) > "$LOG" 2>&1
    done_=$?
    set -e
    # 로그는 끝 200줄만 남긴다
    tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
    if [ "$done_" -eq 0 ]; then
      remember
      notify "폰 앱을 다시 설치했어요. 서명이 $(days_left)일 남았어요."
    else
      if [ "$LEFT" -le 0 ]; then when="서명이 끝났어요"; else when="서명이 ${LEFT}일 남았어요"; fi
      notify "폰 앱을 다시 설치하지 못했어요. $when. 폰을 맥과 같은 Wi-Fi 에 두고 잠금을 풀어 주세요."
      exit 1
    fi ;;
  *) echo "모르는 옵션: $1" >&2; exit 2 ;;
esac
