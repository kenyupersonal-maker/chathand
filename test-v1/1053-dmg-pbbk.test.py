#!/usr/bin/env python3
"""Focused DS_Store behavior check; run with the pinned isolated dmg-env Python."""
import ast
import struct
import tempfile
from pathlib import Path

from ds_store import DSStore
from mac_alias import Bookmark, Data
from mac_alias.bookmark import (
    kBookmarkVolumeProperties,
    kBookmarkVolumeName,
    kCFURLVolumeIsDiskImage,
    kCFURLVolumeIsInternal,
)


SOURCE = Path(__file__).resolve().parents[1] / 'scripts/build-dmg.py'
TREE = ast.parse(SOURCE.read_text())
FUNCTION = next(
    node for node in TREE.body
    if isinstance(node, ast.FunctionDef) and node.name == 'normalize_background_bookmark'
)
NAMESPACE = {}
exec(compile(ast.Module(body=[FUNCTION], type_ignores=[]), str(SOURCE), 'exec'), NAMESPACE)
normalize = NAMESPACE['normalize_background_bookmark']


def make_store(path, alias, bookmark=None, include_alias=True):
    icon_view = {'backgroundType': 2}
    if include_alias:
        icon_view['backgroundImageAlias'] = alias
    with DSStore.open(str(path), 'w+') as store:
        store['.']['vSrn'] = ('long', 1)
        store['.']['icvp'] = icon_view
        store['.']['bwsp'] = {'ShowToolbar': False}
        if bookmark is not None:
            store['.']['pBBk'] = bookmark


def main():
    with tempfile.TemporaryDirectory(prefix='dmg-pbbk-test-') as temp:
        root = Path(temp)
        background = root / '.background.tiff'
        background.write_bytes(b'local test background')
        # The Finder alias is opaque plist data to this normalizer; use a stable
        # byte payload so the test verifies it is preserved exactly.
        alias = b'opaque-background-alias-fixture'

        missing = root / 'no-pBBk.DS_Store'
        make_store(missing, alias)
        with DSStore.open(str(missing), 'r+') as store:
            assert normalize(store) == 'alias-only'
            assert store['.']['icvp']['backgroundImageAlias'] == alias
            assert next(store.find('.', 'pBBk'), None) is None

        present = root / 'with-pBBk.DS_Store'
        bookmark = Bookmark.for_file(str(background))
        original = bookmark.tocs[0][1][kBookmarkVolumeProperties]
        before_flags, before_mask, before_reserved = struct.unpack('<QQQ', original.bytes)
        make_store(present, alias, bookmark)
        with DSStore.open(str(present), 'r+') as store:
            assert normalize(store) == 'normalized'
            assert store['.']['icvp']['backgroundImageAlias'] == alias
            saved = store['.']['pBBk']
            after_flags, after_mask, after_reserved = struct.unpack(
                '<QQQ', saved.tocs[0][1][kBookmarkVolumeProperties].bytes
            )
            assert after_flags == (before_flags & ~kCFURLVolumeIsInternal) | kCFURLVolumeIsDiskImage
            assert after_mask == before_mask
            assert after_reserved == before_reserved
            assert saved.tocs[0][1][kBookmarkVolumeName] == bookmark.tocs[0][1][kBookmarkVolumeName]

        malformed = root / 'malformed-pBBk.DS_Store'
        malformed_toc = dict(bookmark.tocs[0][1])
        malformed_toc.pop(kBookmarkVolumeProperties)
        make_store(malformed, alias, Bookmark([(bookmark.tocs[0][0], malformed_toc)]))
        with DSStore.open(str(malformed), 'r+') as store:
            try:
                normalize(store)
            except (KeyError, IndexError, TypeError, struct.error):
                pass
            else:
                raise AssertionError('malformed pBBk must fail')

        malformed_properties = root / 'malformed-properties.DS_Store'
        malformed_toc = dict(bookmark.tocs[0][1])
        malformed_toc[kBookmarkVolumeProperties] = Data(b'short')
        make_store(malformed_properties, alias, Bookmark([(bookmark.tocs[0][0], malformed_toc)]))
        with DSStore.open(str(malformed_properties), 'r+') as store:
            try:
                normalize(store)
            except struct.error:
                pass
            else:
                raise AssertionError('malformed volume properties must fail')

        missing_alias = root / 'missing-alias.DS_Store'
        make_store(missing_alias, alias, include_alias=False)
        with DSStore.open(str(missing_alias), 'r+') as store:
            try:
                normalize(store)
            except RuntimeError as error:
                assert str(error) == 'DMG_BACKGROUND_ALIAS_MISSING'
            else:
                raise AssertionError('missing background alias must fail')

    print('DS_Store pBBk behavior: 5/5 passed')


if __name__ == '__main__':
    main()
