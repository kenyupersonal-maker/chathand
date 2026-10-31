#!/usr/bin/env python3
"""Create a Finder-layout DMG without controlling Finder or changing system settings."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile


def normalize_background_bookmark(store):
    """Normalize a Finder volume bookmark when present; dmgbuild only writes the icvp alias."""
    import struct
    from mac_alias import Data
    from mac_alias.bookmark import (
        kBookmarkVolumeProperties,
        kCFURLVolumeIsDiskImage,
        kCFURLVolumeIsInternal,
    )

    icon_view = store['.']['icvp']
    if icon_view.get('backgroundType') != 2 or not icon_view.get('backgroundImageAlias'):
        raise RuntimeError('DMG_BACKGROUND_ALIAS_MISSING')

    record = next(store.find('.', 'pBBk'), None)
    if record is None:
        return 'alias-only'

    bookmark = store['.']['pBBk']
    properties = bookmark.tocs[0][1][kBookmarkVolumeProperties]
    flags, mask, reserved = struct.unpack('<QQQ', properties.bytes)
    flags = (flags & ~kCFURLVolumeIsInternal) | kCFURLVolumeIsDiskImage
    bookmark.tocs[0][1][kBookmarkVolumeProperties] = Data(struct.pack('<QQQ', flags, mask, reserved))
    store['.']['pBBk'] = bookmark
    return 'normalized'


def normalize_background_alias(store, volume_name):
    from dmg_finder_alias import normalize_legacy_volume_name

    icon_view = store['.']['icvp']
    alias = icon_view.get('backgroundImageAlias')
    if not alias:
        raise RuntimeError('DMG_BACKGROUND_ALIAS_MISSING')
    fixed = normalize_legacy_volume_name(alias)
    if fixed == alias:
        return 'unchanged'
    import unicodedata
    from mac_alias import Alias
    parsed_volume = Alias.from_bytes(fixed).volume.name
    if unicodedata.normalize('NFC', parsed_volume) != unicodedata.normalize('NFC', volume_name):
        raise RuntimeError('DMG_BACKGROUND_ALIAS_VOLUME_MISMATCH')
    icon_view['backgroundImageAlias'] = fixed
    store['.']['icvp'] = icon_view
    return 'utf8-prefix-repaired'


def verify_finder_background(dmg):
    """Mount the finished DMG read-only and fail unless Finder can find the background.

    Finder (macOS 26) silently drops the whole icon-view record (background
    picture, icon size, text size) when any value is outside the range its
    View Options panel allows. r1-r3 used grid spacing 128 (Finder allows at
    most 100), which is why the installer window stayed white. Fail the build
    instead of shipping a white installer window.
    """
    import plistlib
    from ds_store import DSStore
    from mac_alias import Alias

    with tempfile.TemporaryDirectory(prefix='chathand-dmg-verify-') as temp:
        mount = pathlib.Path(temp) / 'mnt'
        mount.mkdir()
        subprocess.run(['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen',
                        '-mountpoint', str(mount), str(dmg)], check=True, stdout=subprocess.DEVNULL)
        try:
            info = plistlib.loads(subprocess.run(['/usr/sbin/diskutil', 'info', '-plist', str(mount)],
                                                 check=True, capture_output=True).stdout)
            if info.get('FilesystemType') != 'apfs':
                raise SystemExit('DMG_BACKGROUND_FS_NOT_APFS: ' + str(info.get('FilesystemType')))
            with DSStore.open(str(mount / '.DS_Store'), 'r') as store:
                if next(store.find('.', 'pBBk'), None) is not None:
                    raise SystemExit('DMG_BACKGROUND_PBBK_PRESENT')
                icon_view = store['.']['icvp']
            for key, low, high in (('gridSpacing', 1, 100), ('iconSize', 16, 512), ('textSize', 10, 16)):
                value = icon_view.get(key)
                if not isinstance(value, (int, float)) or not low <= value <= high:
                    raise SystemExit('DMG_ICON_VIEW_OUT_OF_RANGE: ' + key + '=' + str(value))
            if icon_view.get('backgroundType') != 2:
                raise SystemExit('DMG_BACKGROUND_TYPE_NOT_PICTURE')
            target = Alias.from_bytes(icon_view['backgroundImageAlias']).target.posix_path
            if not target or not (mount / target.lstrip('/')).is_file():
                raise SystemExit('DMG_BACKGROUND_ALIAS_UNRESOLVED: ' + str(target))
        finally:
            subprocess.run(['/usr/bin/hdiutil', 'detach', str(mount)], check=True, stdout=subprocess.DEVNULL)
    return 'apfs, ' + target + ' via icvp alias, no pBBk'


root = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--app', required=True, type=pathlib.Path)
parser.add_argument('--output', required=True, type=pathlib.Path)
parser.add_argument('--locale', choices=['zh', 'en'], help='Explicit build language for Finder labels, background and offline help (default: zh)')
parser.add_argument('--volume-name', help='Override the volume name for an isolated Finder layout check')
opts = parser.parse_args()
locale = opts.locale or 'zh'
pkg = json.loads((root / 'package.json').read_text())
volume_name = opts.volume_name or 'ChatHand ' + pkg['version'] + (' 中文' if locale == 'zh' else '')
asset_root = root / 'ui/assets/dmg'
assets = asset_root / locale if (asset_root / locale).is_dir() else asset_root
if locale == 'en' and assets == asset_root:
    raise SystemExit('DMG_LOCALE_ASSETS_MISSING: generate and render zh/en artwork first')

if not opts.app.is_absolute() or not opts.app.is_dir():
    raise SystemExit('Pass the absolute built .app path')
if opts.output.exists():
    raise SystemExit('Refusing to replace existing DMG')
# Reject stale artwork before any signing check, mount, copy, or packaging work.
try:
    stamp = json.loads((assets / 'background.stamp.json').read_text())
    template_sha = hashlib.sha256((asset_root / 'src/background.template.html').read_bytes()).hexdigest()
    if (stamp.get('format'), stamp.get('width'), stamp.get('height'), stamp.get('version'), stamp.get('template_sha256')) != (1, 698, 718, pkg['version'], template_sha):
        raise ValueError('metadata mismatch')
    if stamp.get('locale') != locale:
        raise ValueError('language mismatch')
    tables = {language: json.loads((root / 'locales' / (language + '.json')).read_text()) for language in ('zh', 'en')}
    relevant = {language: {key: value for key, value in sorted(tables[language].items())
                          if key.startswith('dmg.') or key in ('ui.h10.prompts.installPrompt', 'ui.h10.prompts.downloadLocationPlaceholder')}
                for language in ('zh', 'en')}
    catalog_bytes = json.dumps(relevant, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if stamp.get('catalog_sha256') != hashlib.sha256(catalog_bytes).hexdigest():
        raise ValueError('catalog mismatch')
    source_names = ['ui/h10/offline.mjs', 'ui/h10/prompts.mjs'] + [
        'ui/assets/dmg/src/' + name for name in (
            'background.template.html', 'jump.template.html', 'first-open.template.html',
            'system-guide.html', 'theme.css', 'localize.mjs', 'generate.mjs', 'render.mjs',
            'install-command.txt', 'codexdoc.svg', 'helpdoc.svg')]
    if set(stamp.get('source_sha256', {})) != set(source_names):
        raise ValueError('source list mismatch')
    for name in source_names:
        if stamp['source_sha256'][name] != hashlib.sha256((root / name).read_bytes()).hexdigest():
            raise ValueError('source mismatch')
    for name in ('background.html', 'background.png', 'background@2x.png', 'background.tiff',
                 '让 ChatGPT 来装.html', '第一次打开.html', 'codexdoc.icns', 'helpdoc.icns'):
        data = (assets / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != stamp['assets'][name]['sha256']:
            raise ValueError('asset mismatch')
        if name.endswith('.png'):
            import struct
            expected = (1396, 1436) if '@2x' in name else (698, 718)
            if data[:8] != b'\x89PNG\r\n\x1a\n' or struct.unpack('>II', data[16:24]) != expected:
                raise ValueError('image dimensions mismatch')
except (OSError, ValueError, KeyError, TypeError) as error:
    raise SystemExit('DMG_BACKGROUND_STAMP_INVALID: regenerate current artwork') from error

from local_text import local_text

def text(key):
    return local_text(key, locale=locale)


if sys.version_info < (3, 10):
    raise SystemExit('DMG_PYTHON_TOO_OLD: use the pinned dmg-env (Python 3.10+, dmgbuild 1.6.7)')
subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(opts.app)], check=True)
help_source = assets / '第一次打开.html'
if not help_source.is_file():
    raise SystemExit('Offline help page missing')

with tempfile.TemporaryDirectory(prefix='chathand-dmg-') as temp:
    work = pathlib.Path(temp)
    entry = work / text('dmg.entry')
    shutil.copyfile(assets / '让 ChatGPT 来装.html', entry)

    help_page = work / text('dmg.help')
    shutil.copyfile(help_source, help_page)
    subprocess.run(['/usr/bin/xcrun', 'swift', str(root / 'scripts/set-dmg-help-icon.swift'),
                    str(assets / 'codexdoc.icns'), str(entry)], check=True)
    subprocess.run(['/usr/bin/xcrun', 'swift', str(root / 'scripts/set-dmg-help-icon.swift'),
                    str(assets / 'helpdoc.icns'), str(help_page)], check=True)

    opts.output.parent.mkdir(parents=True, exist_ok=True)
    entry_name = entry.name
    settings = {
        'format': 'UDZO',
        'filesystem': 'APFS',
        'files': [str(opts.app), str(entry), str(help_page)],
        'symlinks': {text('dmg.applications'): '/Applications'},
        'volume_name': volume_name,
        'background': str(assets / 'background.tiff'),
        'window_rect': ((160, 120), (698, 750)),
        'grid_spacing': 100,  # Finder ignores the whole icon view above 100
        'icon_size': 64,
        'text_size': 12,
        'icon_locations': {
            entry_name: (565, 276),
            'ChatHand.app': (350, 578),
            text('dmg.applications'): (486, 578),
            help_page.name: (610, 578),
        },
        'hide_extensions': [entry_name, help_page.name],
        'show_toolbar': False,
        'show_status_bar': False,
        'show_pathbar': False,
        'show_sidebar': False,
        'include_icon_view_settings': True,
        'default_view': 'icon-view',
        'license': None,
    }

    # mac_alias marks every bookmark volume as internal (0x80), including
    # disk images. Tahoe cannot resolve that pBBk; correct only the volume
    # classification, keeping its volume UUID and relative file identity.
    mount = [None]

    def capture_mount(mount_point, options):
        mount[0] = pathlib.Path(mount_point)

    def after_layout(event):
        if event.get('type') == 'operation::finished' and event.get('operation') == 'dsstore::create':
            from ds_store import DSStore
            with DSStore.open(str(mount[0] / '.DS_Store'), 'r+') as d:
                status = normalize_background_bookmark(d)
                alias_status = normalize_background_alias(d, volume_name)
            print('DMG_BACKGROUND_BOOKMARK_STATUS=' + status)
            print('DMG_BACKGROUND_ALIAS_STATUS=' + alias_status)
            if status != 'alias-only':
                raise SystemExit('DMG_BACKGROUND_PBBK_PRESENT: pin dmgbuild 1.6.7 from requirements-packaging.txt')

    settings['create_hook'] = capture_mount
    import dmgbuild
    dmgbuild.build_dmg(str(opts.output), volume_name, settings=settings, callback=after_layout)

print('DMG_BACKGROUND_CHECK=' + verify_finder_background(opts.output))
sha = hashlib.sha256(opts.output.read_bytes()).hexdigest()
opts.output.with_suffix('.dmg.sha256').write_text(sha + '  ' + opts.output.name + '\n')
print(json.dumps({'dmg': str(opts.output), 'sha256': sha, 'version': pkg['version'],
                  'codex_entry': 'html', 'finder_labels_locale': locale, 'background_locale': locale, 'offline_help_locale': locale, 'dynamic_language_switching': False}, ensure_ascii=False))
