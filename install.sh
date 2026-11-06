#!/system/bin/sh
# Experimental; installs own files only. Does not flash or issue any card command.
set -eu
umask 077
BASE=/data/adb/f50-esim
SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo 'Root shell required'; exit 1; }
[ ! -d "$BASE/read.lock" ] || { echo 'Reader busy or stale lock: investigate before installing'; exit 1; }
[ -x /data/user/0/com.minikano.f50_sms/files/sendat ] || { echo 'Compatible UFI sendat is missing'; exit 1; }
BB=/data/adb/magisk/busybox
[ -x "$BB" ] || { echo 'Magisk BusyBox required'; exit 1; }
[ "$(getprop ro.product.model)" = MU3356 ] || { echo 'Only MU3356 tested; refusing this device'; exit 1; }
cd "$SRC"
"$BB" sha256sum -c SHA256SUMS || exit 1
printf 'EXPERIMENTAL: real profile writes are NOT fully validated.\n'
printf 'Type the expected 32-digit EID from your own prior read (local only): '
stty -echo 2>/dev/null || true
IFS= read -r EID
stty echo 2>/dev/null || true
printf '\n'
case "$EID" in *[!0-9]*|'') echo 'Invalid EID'; exit 1;; esac
[ "${#EID}" = 32 ] || { echo 'EID must have 32 digits'; exit 1; }
mkdir -p "$BASE"
if [ -e "$BASE/manager" ] || [ -e "$BASE/eid.sha256" ]; then
 BACKUP="$BASE/backup-$(date +%Y%m%d-%H%M%S)-$$"
 mkdir "$BACKUP"
 for f in manager manager.sh lpac eid.sha256; do [ ! -f "$BASE/$f" ] || cp -p "$BASE/$f" "$BACKUP/$f"; done
 echo "Existing files preserved at $BACKUP"
fi
for f in manager manager.sh lpac; do cp "$SRC/$f" "$BASE/$f.new"; chmod 700 "$BASE/$f.new"; mv "$BASE/$f.new" "$BASE/$f"; done
# Hash EID binary BCD bytes, identical to GetEID response body representation.
HEXESC=$(printf '%s' "$EID" | "$BB" sed 's/../\\x&/g')
printf '%b' "$HEXESC" | "$BB" sha256sum | "$BB" cut -d' ' -f1 > "$BASE/eid.sha256"
EID=; HEXESC=
chmod 700 "$BASE"
chmod 600 "$BASE/eid.sha256"
echo 'Files installed; import F50-9esim-Manager.txt through UFI plugin settings.'
echo 'No card write or network change was performed. Verify status and reads first.'
