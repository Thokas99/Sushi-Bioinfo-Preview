#!/usr/bin/env bash
set -euo pipefail
APP=org.gnome.NautilusPreviewer
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOST_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
DATA="$HOME/.var/app/$APP/data/sushi"
BACKUP="$DATA/bioinfo-preview-backup"
STATE="$BACKUP/.installed"
if [[ ! -s "$STATE" ]]; then
  echo 'No Sushi Bioinfo Preview installation record; nothing removed.'
  exit 0
fi
read -r INSTALLED_SLOT SERIES < "$STATE"
if [[ "$INSTALLED_SLOT" == plugins-1 && "$SERIES" == 51 ]]; then
  OTHER_SLOT=viewers
elif [[ "$INSTALLED_SLOT" == viewers && "$SERIES" == 50 ]]; then
  OTHER_SLOT=plugins-1
else
  echo 'Invalid Sushi Bioinfo Preview installation record; no files changed.' >&2
  exit 1
fi

expected_hash() { awk -v name="$1" '$1 == name {print $2; exit}' "$STATE"; }
matches_installed() {
  local wanted actual
  wanted="$(expected_hash "$1")"
  [[ -n "$wanted" && -f "$2" ]] || return 1
  actual="$(sha256sum -- "$2" | awk '{print $1}')"
  [[ "$actual" == "$wanted" ]]
}

for part in table document office; do
  name="lab-$part-preview.js"
  target="$DATA/$INSTALLED_SLOT/$name"
  old="$BACKUP/$INSTALLED_SLOT-$name"
  if [[ -f "$old" || -L "$old" ]]; then
    if [[ ! -e "$target" && ! -L "$target" ]] || matches_installed "$name" "$target"; then
      rm -f -- "$target"
      mkdir -p "$(dirname -- "$target")"
      cp -pP -- "$old" "$target"
    else
      echo "Preserved changed file: $target"
    fi
  elif matches_installed "$name" "$target"; then
    rm -f -- "$target"
  elif [[ -e "$target" || -L "$target" ]]; then
    echo "Preserved file not matching the installed preview: $target"
  fi

  target="$DATA/$OTHER_SLOT/$name"
  old="$BACKUP/$OTHER_SLOT-$name"
  if [[ ( -f "$old" || -L "$old" ) && ! -e "$target" && ! -L "$target" ]]; then
    mkdir -p "$(dirname -- "$target")"
    cp -pP -- "$old" "$target"
  fi
done

for scope in host flatpak; do
  if [[ "$scope" == host ]]; then base="$HOST_DATA_DIR/mime"; else base="$HOME/.var/app/$APP/data/mime"; fi
  [[ -d "$base" ]] || continue
  target="$base/packages/sushi-bioinfo-preview.xml"
  old="$BACKUP/$scope-existing-mime.xml"
  if [[ -f "$old" || -L "$old" ]]; then
    if [[ ! -e "$target" && ! -L "$target" ]] || matches_installed 'sushi-bioinfo-preview.xml' "$target"; then
      rm -f -- "$target"
      cp -pP -- "$old" "$target"
    else
      echo "Preserved changed file: $target"
    fi
  elif matches_installed 'sushi-bioinfo-preview.xml' "$target"; then
    rm -f -- "$target"
  elif [[ -e "$target" || -L "$target" ]]; then
    echo "Preserved file not matching the installed MIME definition: $target"
  fi
  old="$BACKUP/$scope-legacy-mime.xml"
  target="$base/packages/sushi-lab-preview.xml"
  if [[ ( -f "$old" || -L "$old" ) && ! -e "$target" && ! -L "$target" ]]; then
    cp -pP -- "$old" "$target"
  fi
  if command -v update-mime-database >/dev/null; then update-mime-database "$base"; fi
done

LEGACY="$HOME/.local/share/sushi-lab-preview/office-pdf-host.py"
if [[ -f "$BACKUP/legacy-office-pdf-host.py" && ! -e "$LEGACY" && ! -L "$LEGACY" ]]; then
  mkdir -p "$(dirname -- "$LEGACY")"
  cp -p -- "$BACKUP/legacy-office-pdf-host.py" "$LEGACY"
fi
printf 'uninstalled\n' > "$BACKUP/.uninstalled.tmp"
mv -f -- "$BACKUP/.uninstalled.tmp" "$BACKUP/.uninstalled"
rm -f -- "$STATE"
echo 'Previous Sushi files restored where unchanged or absent. Restart Sushi to apply.'
