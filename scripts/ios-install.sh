#!/bin/sh
# 아이폰에 NekoDesk 를 빌드해 설치한다(덮어 설치 — 폰의 데이터는 남는다). docs/neko-sync.md §12
#   scripts/ios-install.sh            연결된 아이폰 전부에
#   scripts/ios-install.sh --no-build  마지막으로 만든 것을 다시 설치만
# 준비: Xcode 에서 gen/apple/nekodesk.xcodeproj › Signing & Capabilities › Team 을 한 번 고르고,
#       그 팀 ID(10글자)를 src-tauri/gen/apple/.team 에 적는다(git 에 안 올라간다). 무료 계정은 7일마다 다시 설치한다.
set -eu
cd "$(dirname "$0")/.."
APPLE="src-tauri/gen/apple"
IPA="$APPLE/build/arm64/NekoDesk.ipa"

if [ "${1:-}" != "--no-build" ]; then
  APPLE_DEVELOPMENT_TEAM="${APPLE_DEVELOPMENT_TEAM:-$(cat "$APPLE/.team" 2>/dev/null || true)}"
  [ -n "$APPLE_DEVELOPMENT_TEAM" ] || { echo "팀 ID 가 없어. $APPLE/.team 에 적어줘(위 '준비')." >&2; exit 1; }
  export APPLE_DEVELOPMENT_TEAM
  # Xcode 27: swift-rs 가 Swift 쪽 심볼을 되살리는 데 llvm-objcopy 를 쓴다. 없으면 링크가 "Undefined symbols" 로 실패한다.
  rustup component list --installed | grep -q '^llvm-tools' || rustup component add llvm-tools
  # 지난 산출물이 남아 있으면 tauri 가 옮기다 실패한다("Directory not empty")
  rm -rf "$APPLE/build/arm64" "$APPLE/build/nekodesk_iOS.xcarchive"
  npx tauri ios build --ci
  # 빌드가 Xcode 프로젝트에 팀 ID 를 적어 넣는다. 계정마다 다른 값이라 커밋에 섞이지 않게 되돌린다
  git checkout -- "$APPLE/nekodesk.xcodeproj" 2>/dev/null || true
fi

[ -f "$IPA" ] || { echo "$IPA 가 없어. --no-build 없이 다시 돌려줘." >&2; exit 1; }
# 맥이 아는 아이폰. Wi-Fi 로 붙은 폰은 쉬는 동안 "available (paired)" 로만 보여도 설치하면 그때 붙는다 —
# "connected" 만 찾으면 같은 Wi-Fi 에 있어도 못 찾았다. 아이패드·시뮬레이터는 뺀다
DEVICES=$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ && /physical/ && (/connected/ || /available/) { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]+-[0-9A-F]+$/) print $i }')
[ -n "$DEVICES" ] || { echo "연결된 아이폰이 없어. 케이블로 연결하고 잠금을 풀어줘." >&2; exit 1; }
for d in $DEVICES; do
  echo "설치: $d"
  xcrun devicectl device install app --device "$d" "$IPA"
done
