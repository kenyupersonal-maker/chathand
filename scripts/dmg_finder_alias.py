"""Repair the legacy volume-name field of a Finder background alias."""

import struct


def normalize_legacy_volume_name(data):
    """Keep the complete Unicode volume name while fixing a split UTF-8 prefix.

    Version 2 aliases contain a 27-byte Pascal-string prefix and a separate
    Unicode volume-name record. dmgbuild's mac_alias can cut that prefix in
    the middle of a character; leave all other fields and records untouched.
    """
    if not isinstance(data, bytes) or len(data) < 150:
        raise ValueError('DMG_BACKGROUND_ALIAS_INVALID')
    if struct.unpack_from('>h', data, 6)[0] != 2:
        return data
    length = data[10]
    if length > 27:
        raise ValueError('DMG_BACKGROUND_ALIAS_INVALID')
    prefix = data[11:11 + length]
    try:
        prefix.decode('utf-8')
    except UnicodeDecodeError as error:
        if error.reason != 'unexpected end of data' or error.end != len(prefix):
            raise ValueError('DMG_BACKGROUND_ALIAS_INVALID') from error
        prefix = prefix[:error.start]
        fixed = bytearray(data)
        fixed[10] = len(prefix)
        fixed[11:38] = prefix.ljust(27, b'\0')
        return bytes(fixed)
    return data
