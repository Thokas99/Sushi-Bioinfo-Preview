#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

make_home() {
  local home="$1" version="$2"
  mkdir -p "$home/.var/app/org.gnome.NautilusPreviewer/data" \
    "$home/.local/share/mime/packages" "$tmp/bin"
  cat > "$tmp/bin/flatpak" <<EOF
#!/bin/bash
case "\$1" in
  info) exit 0;;
  list) printf 'org.gnome.NautilusPreviewer\\t$version\\n';;
  override) exit 0;;
esac
EOF
  printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/update-mime-database"
  chmod +x "$tmp/bin/flatpak" "$tmp/bin/update-mime-database"
}

for version in 50.0 51.1; do
  home="$tmp/home-$version"
  make_home "$home" "$version"
  slot=viewers; other=plugins-1
  [[ $version == 51.1 ]] && { slot=plugins-1; other=viewers; }
  data="$home/.var/app/org.gnome.NautilusPreviewer/data/sushi"
  mkdir -p "$data/$slot" "$data/$other"
  printf 'previous active table' > "$data/$slot/lab-table-preview.js"
  printf 'previous inactive office' > "$data/$other/lab-office-preview.js"
  printf 'symlink target data' > "$home/document-target"
  ln -s "$home/document-target" "$data/$slot/lab-document-preview.js"
  printf 'legacy MIME' > "$home/.local/share/mime/packages/sushi-lab-preview.xml"
  printf 'user MIME' > "$home/.local/share/mime/packages/sushi-bioinfo-preview.xml"

  (HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/install.sh") >/dev/null
  active="$data/$slot"
  test -s "$active/lab-table-preview.js"
  test ! -e "$active/lab-office-preview.js"
  test -s "$active/lab-document-preview.js"
  [[ $(cat "$home/document-target") == 'symlink target data' ]]
  test ! -e "$data/$other/lab-office-preview.js"
  test -e "$home/.local/share/mime/packages/sushi-bioinfo-preview.xml"
  test ! -e "$home/.local/share/mime/packages/sushi-lab-preview.xml"
  # Reinstallation must not replace the original recovery copies.
  (HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/install.sh") >/dev/null
  (HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/uninstall.sh") >/dev/null
  [[ $(cat "$active/lab-table-preview.js") == 'previous active table' ]]
  [[ $(cat "$data/$other/lab-office-preview.js") == 'previous inactive office' ]]
  test -L "$active/lab-document-preview.js"
  [[ $(readlink "$active/lab-document-preview.js") == "$home/document-target" ]]
  [[ $(cat "$home/.local/share/mime/packages/sushi-lab-preview.xml") == 'legacy MIME' ]]
  [[ $(cat "$home/.local/share/mime/packages/sushi-bioinfo-preview.xml") == 'user MIME' ]]
done

# Uninstall preserves files changed by the user after installation.
home="$tmp/changed"
make_home "$home" 51.1
data="$home/.var/app/org.gnome.NautilusPreviewer/data/sushi"
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/install.sh") >/dev/null
printf 'user edit' > "$data/plugins-1/lab-table-preview.js"
printf 'user MIME edit' > "$home/.local/share/mime/packages/sushi-bioinfo-preview.xml"
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/uninstall.sh") >/dev/null
[[ $(cat "$data/plugins-1/lab-table-preview.js") == 'user edit' ]]
[[ $(cat "$home/.local/share/mime/packages/sushi-bioinfo-preview.xml") == 'user MIME edit' ]]

# A fresh install after uninstall snapshots the then-current files, not stale backups.
home="$tmp/rebased-backup"
make_home "$home" 51.1
data="$home/.var/app/org.gnome.NautilusPreviewer/data/sushi"
mkdir -p "$data/plugins-1" "$data/viewers"
printf 'first prior table' > "$data/plugins-1/lab-table-preview.js"
printf 'prior inactive office' > "$data/viewers/lab-office-preview.js"
printf 'first prior MIME' > "$home/.local/share/mime/packages/sushi-bioinfo-preview.xml"
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/install.sh") >/dev/null
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/uninstall.sh") >/dev/null
printf 'updated prior table' > "$data/plugins-1/lab-table-preview.js"
rm "$data/viewers/lab-office-preview.js"
printf 'updated prior MIME' > "$home/.local/share/mime/packages/sushi-bioinfo-preview.xml"
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/install.sh") >/dev/null
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/uninstall.sh") >/dev/null
[[ $(cat "$data/plugins-1/lab-table-preview.js") == 'updated prior table' ]]
test ! -e "$data/viewers/lab-office-preview.js"
[[ $(cat "$home/.local/share/mime/packages/sushi-bioinfo-preview.xml") == 'updated prior MIME' ]]

# Host MIME registration follows XDG_DATA_HOME when configured.
home="$tmp/custom-xdg"
xdg="$home/custom-data"
make_home "$home" 51.1
mkdir -p "$xdg/mime/packages"
printf 'custom MIME' > "$xdg/mime/packages/sushi-bioinfo-preview.xml"
(HOME="$home" XDG_DATA_HOME="$xdg" PATH="$tmp/bin:$PATH" bash "$ROOT/install.sh") >/dev/null
test -e "$xdg/mime/packages/sushi-bioinfo-preview.xml"
test ! -e "$home/.local/share/mime/packages/sushi-bioinfo-preview.xml"
(HOME="$home" XDG_DATA_HOME="$xdg" PATH="$tmp/bin:$PATH" bash "$ROOT/uninstall.sh") >/dev/null
[[ $(cat "$xdg/mime/packages/sushi-bioinfo-preview.xml") == 'custom MIME' ]]

# The obsolete v7 permission is revoked only when its environment override exists.
home="$tmp/legacy-bridge"
make_home "$home" 51.1
cat > "$tmp/bin/flatpak" <<'EOF'
#!/bin/bash
case "$1" in
  info) exit 0;;
  list) printf 'org.gnome.NautilusPreviewer\t51.1\n';;
  override)
    if [[ "$2" == --user && "$3" == --show ]]; then
      printf 'SUSHI_LAB_REAL_OFFICE=1\norg.freedesktop.Flatpak=talk\norg.freedesktop.DBus=session\n'
    else
      printf '%s\n' "$*" >> "$HOME/override.log"
    fi
    ;;
esac
EOF
chmod +x "$tmp/bin/flatpak"
legacy="$home/.local/share/sushi-lab-preview/office-pdf-host.py"
mkdir -p "$(dirname "$legacy")"
printf '# old sushi-lab-lo bridge\n' > "$legacy"
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/install.sh") >/dev/null
test ! -e "$legacy"
grep -Fq -- '--unset-env=SUSHI_LAB_REAL_OFFICE' "$home/override.log"
grep -Fq -- '--no-talk-name=org.freedesktop.Flatpak' "$home/override.log"
! grep -Fq -- 'org.freedesktop.DBus' "$home/override.log"
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/uninstall.sh") >/dev/null
test -e "$legacy"

# A missing MIME source also fails before touching user data.
copy="$tmp/copy-no-mime"
mkdir -p "$copy"
cp -R "$ROOT/dist" "$ROOT/mime" "$copy/"
cp "$ROOT/install.sh" "$copy/"
rm "$copy/mime/sushi-bioinfo-preview.xml"
home="$tmp/missing-mime"
make_home "$home" 51.1
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$copy/install.sh") >/dev/null 2>&1 && exit 1
test ! -e "$home/.var/app/org.gnome.NautilusPreviewer/data/sushi"

# Existing prototype backups without the new state file are treated as recovery data.
home="$tmp/legacy-backup"
make_home "$home" 50.0
data="$home/.var/app/org.gnome.NautilusPreviewer/data/sushi"
backup="$data/bioinfo-preview-backup"
mkdir -p "$data/viewers" "$backup"
printf 'older prototype' > "$data/viewers/lab-table-preview.js"
printf 'original before prototype' > "$backup/viewers-lab-table-preview.js"
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/install.sh") >/dev/null
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/uninstall.sh") >/dev/null
[[ $(cat "$data/viewers/lab-table-preview.js") == 'original before prototype' ]]

# An uninstaller without its installation record must leave same-named user files alone.
home="$tmp/no-record"
make_home "$home" 51.1
data="$home/.var/app/org.gnome.NautilusPreviewer/data/sushi"
mkdir -p "$data/plugins-1"
printf 'unrelated user file' > "$data/plugins-1/lab-table-preview.js"
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$ROOT/uninstall.sh") >/dev/null
[[ $(cat "$data/plugins-1/lab-table-preview.js") == 'unrelated user file' ]]

# Missing distribution input is rejected before app data or MIME files change.
copy="$tmp/copy"
mkdir -p "$copy"
cp -R "$ROOT/dist" "$ROOT/mime" "$copy/"
cp "$ROOT/install.sh" "$copy/"
rm "$copy/dist/bioinfo-document-51.js"
home="$tmp/missing"
make_home "$home" 51.1
(HOME="$home" XDG_DATA_HOME="$home/.local/share" PATH="$tmp/bin:$PATH" bash "$copy/install.sh") >/dev/null 2>&1 && exit 1
test ! -e "$home/.var/app/org.gnome.NautilusPreviewer/data/sushi"
test ! -e "$home/.local/share/mime/packages/sushi-bioinfo-preview.xml"

echo 'Install, reinstall, uninstall restoration, user-file preservation and preflight tests passed.'
