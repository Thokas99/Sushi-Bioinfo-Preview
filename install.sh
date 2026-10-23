#!/usr/bin/env bash
set -euo pipefail
APP=org.gnome.NautilusPreviewer
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOST_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
command -v flatpak >/dev/null || { echo 'Flatpak is required' >&2; exit 1; }
flatpak info "$APP" >/dev/null 2>&1 || { echo "Sushi Flatpak not installed: $APP" >&2; exit 1; }
VERSION="$(flatpak list --app --columns=application,version | awk -v app="$APP" '$1 == app {print $2; exit}')"
if [[ ! "$VERSION" =~ ^([0-9]+) ]]; then echo "Cannot determine Sushi version: $VERSION" >&2; exit 1; fi
MAJOR="${BASH_REMATCH[1]}"
(( MAJOR >= 46 )) || { echo "Unsupported Sushi version: $VERSION" >&2; exit 1; }
command -v update-mime-database >/dev/null || { echo 'Install shared-mime-info (update-mime-database)' >&2; exit 1; }
if (( MAJOR >= 51 )); then SLOT=plugins-1; SERIES=51; OLD_SLOT=viewers
else SLOT=viewers; SERIES=50; OLD_SLOT=plugins-1
fi
DATA="$HOME/.var/app/$APP/data/sushi"
TARGET="$DATA/$SLOT"
OLD_TARGET="$DATA/$OLD_SLOT"
BACKUP="$DATA/bioinfo-preview-backup"
for part in table document; do
  source="$ROOT/dist/bioinfo-$part-$SERIES.js"
  [[ -s "$source" ]] || { echo "Run python3 build.py (missing $source)" >&2; exit 1; }
done
[[ -s "$ROOT/mime/sushi-bioinfo-preview.xml" ]] || { echo "Missing MIME definition: $ROOT/mime/sushi-bioinfo-preview.xml" >&2; exit 1; }
mkdir -p "$TARGET" "$BACKUP"
ACTIVE_INSTALL=0
if [[ -s "$BACKUP/.installed" ]] || { [[ ! -e "$BACKUP/.uninstalled" ]] && compgen -G "$BACKUP/*" >/dev/null; }; then
  ACTIVE_INSTALL=1
fi
for part in table document; do
  dest="$TARGET/lab-$part-preview.js"
  source="$ROOT/dist/bioinfo-$part-$SERIES.js"
  # Preserve only the initial state for uninstall, never overwrite the backup.
  saved="$BACKUP/$SLOT-lab-$part-preview.js"
  if (( ACTIVE_INSTALL == 0 )); then rm -f -- "$saved"; fi
  if [[ ( -f "$dest" || -L "$dest" ) && ( $ACTIVE_INSTALL == 0 || ( ! -e "$saved" && ! -L "$saved" ) ) ]]; then
    cp -pP -- "$dest" "$saved"
  fi
  rm -f -- "$dest"
  install -m 0644 "$source" "$dest"
done
# Remove the inactive Sushi plugin copies while preserving their initial state.
for part in table document; do
  stale="$OLD_TARGET/lab-$part-preview.js"
  saved="$BACKUP/$OLD_SLOT-lab-$part-preview.js"
  if (( ACTIVE_INSTALL == 0 )); then rm -f -- "$saved"; fi
  if [[ -f "$stale" || -L "$stale" ]]; then
    if (( ACTIVE_INSTALL == 0 )) || [[ ! -e "$saved" && ! -L "$saved" ]]; then cp -pP -- "$stale" "$saved"; fi
    rm -f -- "$stale"
  fi
done
# Retire the old Office extraction plugin and retain any pre-install file.
for slot in "$SLOT" "$OLD_SLOT"; do
  obsolete="$DATA/$slot/lab-office-preview.js"
  saved="$BACKUP/$slot-lab-office-preview.js"
  if (( ACTIVE_INSTALL == 0 )); then rm -f -- "$saved"; fi
  if [[ -f "$obsolete" || -L "$obsolete" ]]; then
    if (( ACTIVE_INSTALL )); then
      expected="$(awk '$1 == "lab-office-preview.js" {print $2; exit}' "$BACKUP/.installed" 2>/dev/null || true)"
      actual="$(sha256sum -- "$obsolete" | awk '{print $1}')"
      if [[ "$slot" == "$SLOT" && -n "$expected" && "$actual" == "$expected" ]]; then
        rm -f -- "$obsolete"
      fi
      continue
    fi
    cp -pP -- "$obsolete" "$saved"
    rm -f -- "$obsolete"
  fi
done
# Use one XML at a time; the v7 MIME registration must not compete with v8.
for scope in host flatpak; do
  if [[ "$scope" == host ]]; then base="$HOST_DATA_DIR/mime"; else base="$HOME/.var/app/$APP/data/mime"; fi
  mkdir -p "$base/packages"
  old="$base/packages/sushi-lab-preview.xml"
  target="$base/packages/sushi-bioinfo-preview.xml"
  saved="$BACKUP/$scope-legacy-mime.xml"
  if (( ACTIVE_INSTALL == 0 )); then rm -f -- "$saved"; fi
  if [[ -f "$old" || -L "$old" ]]; then
    if (( ACTIVE_INSTALL == 0 )) || [[ ! -e "$saved" && ! -L "$saved" ]]; then cp -pP -- "$old" "$saved"; fi
    rm -- "$old"
  fi
  saved="$BACKUP/$scope-existing-mime.xml"
  if (( ACTIVE_INSTALL == 0 )); then rm -f -- "$saved"; fi
  if [[ ( -f "$target" || -L "$target" ) && ( $ACTIVE_INSTALL == 0 || ( ! -e "$saved" && ! -L "$saved" ) ) ]]; then
    cp -pP -- "$target" "$saved"
  fi
  rm -f -- "$target"
  install -m 0644 "$ROOT/mime/sushi-bioinfo-preview.xml" "$target"
  update-mime-database "$base"
done
# Remove only the known v7 helper (never execute or replace host utilities).
LEGACY="$HOME/.local/share/sushi-lab-preview/office-pdf-host.py"
if (( ACTIVE_INSTALL == 0 )); then rm -f -- "$BACKUP/legacy-office-pdf-host.py"; fi
if [[ -f "$LEGACY" ]] && grep -q 'sushi-lab-lo' "$LEGACY"; then
  if (( ACTIVE_INSTALL == 0 )) || [[ ! -e "$BACKUP/legacy-office-pdf-host.py" && ! -L "$BACKUP/legacy-office-pdf-host.py" ]]; then
    cp -pP -- "$LEGACY" "$BACKUP/legacy-office-pdf-host.py"
  fi
  rm -f -- "$LEGACY"
fi
# If the user enabled the v7 host-spawn bridge, explicitly revoke that permission.
# Avoid any change when no such user override exists.
OVERRIDES="$(flatpak override --user --show "$APP" 2>/dev/null || true)"
if grep -Eq '^SUSHI_LAB_REAL_OFFICE=' <<< "$OVERRIDES"; then
  flatpak override --user --unset-env=SUSHI_LAB_REAL_OFFICE "$APP"
  if grep -Eq '^org\.freedesktop\.Flatpak=talk$' <<< "$OVERRIDES"; then
    flatpak override --user --no-talk-name=org.freedesktop.Flatpak "$APP"
  fi
  echo 'Disabled the optional v7 LibreOffice host bridge.'
fi
{
  printf '%s %s\n' "$SLOT" "$SERIES"
  for part in table document; do
    printf 'lab-%s-preview.js %s\n' "$part" "$(sha256sum "$ROOT/dist/bioinfo-$part-$SERIES.js" | awk '{print $1}')"
  done
  printf 'sushi-bioinfo-preview.xml %s\n' "$(sha256sum "$ROOT/mime/sushi-bioinfo-preview.xml" | awk '{print $1}')"
} > "$BACKUP/.installed.tmp"
mv -f -- "$BACKUP/.installed.tmp" "$BACKUP/.installed"
rm -f -- "$BACKUP/.uninstalled"
echo "Sushi Bioinfo Preview installed for Sushi $VERSION ($SLOT)."
echo "Restart: flatpak kill $APP 2>/dev/null || true"
