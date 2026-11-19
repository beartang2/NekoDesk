#!/bin/sh
# 아이폰 앱 자동 재설치를 맥에 등록·해제한다(launchd 사용자 에이전트). docs/neko-sync.md §12.2
#   scripts/ios-reinstall-agent.sh install     날마다 04:30 에 scripts/ios-reinstall.sh --auto 를 돌린다(맥이 자고 있었으면 깰 때)
#   scripts/ios-reinstall-agent.sh uninstall   등록을 풀고 만든 파일을 지운다
#   scripts/ios-reinstall-agent.sh status      등록 상태와 다음 실행
# 만드는 것(내장 디스크): ~/Library/LaunchAgents/com.nekodesk.ios-reinstall.plist,
#                         ~/Library/Application Support/NekoDesk/ios-reinstall-agent.sh
# 서명이 3일 넘게 남은 날은 아무것도 안 한다. 실제 빌드는 4일에 한 번쯤이고 낮은 우선순위(nice)로 돈다.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LABEL="com.nekodesk.ios-reinstall"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HOME/Library/Application Support/NekoDesk"
RUNNER="$STATE/ios-reinstall-agent.sh"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
    # launchd 는 PATH 가 거의 비어 있다. 지금 셸의 PATH(node·cargo·brew)를 적어 둔다.
    # 이 파일은 내장 디스크에 둔다: 외장 디스크가 빠져 있으면 저장소의 스크립트는 아예 못 찾는다.
    cat > "$RUNNER" <<EOF
#!/bin/sh
# NekoDesk 아이폰 앱 자동 재설치 — $ROOT/scripts/ios-reinstall-agent.sh install 이 만든 파일이다. 고치지 말고 다시 install 한다.
export PATH="$PATH"
if [ ! -x "$ROOT/scripts/ios-reinstall.sh" ]; then
  # 외장 디스크가 없다: 조용히 건너뛰되, 지난번에 적어 둔 만료가 3일 안이면 알린다
  end=\$(cat "$STATE/ios-expiry" 2>/dev/null || echo 0)
  left=\$(( (end - \$(date +%s)) / 86400 ))
  [ "\$left" -gt 3 ] || /usr/bin/osascript -e 'on run a' -e 'display notification (item 1 of a) with title "NekoDesk 아이폰 앱"' -e 'end run' "외장 디스크가 없어 폰 앱을 다시 설치하지 못했어요. 서명이 \${left}일 남았어요." >/dev/null 2>&1
  exit 0
fi
exec nice -n 15 "$ROOT/scripts/ios-reinstall.sh" --auto
EOF
    chmod +x "$RUNNER"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>$RUNNER</string>
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>4</integer>
		<key>Minute</key>
		<integer>30</integer>
	</dict>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/dev/null</string>
	<key>StandardErrorPath</key>
	<string>/dev/null</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "등록했어: 날마다 04:30(자고 있었으면 깰 때). 한 일은 $(dirname "$ROOT")/NekoDesk-ios-reinstall.log"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST" "$RUNNER"
    echo "등록을 풀었어."
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E 'state =|last exit code|runs =' || echo "등록돼 있지 않아."
    echo "서명 남은 날: $("$ROOT/scripts/ios-reinstall.sh" --days)"
    ;;
  *) echo "쓰는 법: $0 install | uninstall | status" >&2; exit 2 ;;
esac
