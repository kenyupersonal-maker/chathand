import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Finder alias repairs only a split UTF-8 volume prefix',()=>{
 const scripts=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../scripts');
 const program=String.raw`
import struct, sys
sys.path.insert(0, sys.argv[1])
from dmg_finder_alias import normalize_legacy_volume_name

def record(name, version=2):
    data = bytearray(200)
    struct.pack_into('>h', data, 6, version)
    prefix = name.encode('utf-8')[:27]
    data[10] = len(prefix)
    data[11:38] = prefix.ljust(27, b'\0')
    data[38:] = bytes(range(162))
    return bytes(data)

for name in ('ChatHand 1084 本地十二测', 'ChatHand 1.0.0-beta.34 中文', 'a' * 26 + '😀'):
    raw = record(name)
    try: raw[11:11 + raw[10]].decode('utf-8')
    except UnicodeDecodeError: pass
    else: raise AssertionError('fixture must split a character')
    fixed = normalize_legacy_volume_name(raw)
    fixed[11:11 + fixed[10]].decode('utf-8')
    assert fixed[:10] == raw[:10] and fixed[38:] == raw[38:] and len(fixed) == len(raw)

for name in ('ChatHand 1084 十二测', 'x' * 40, 'a' * 24 + '中'):
    raw = record(name)
    assert normalize_legacy_volume_name(raw) == raw
assert normalize_legacy_volume_name(record('a' * 26 + '😀', 3)) == record('a' * 26 + '😀', 3)
bad = bytearray(record('short'))
bad[10] = 2
bad[11:13] = b'\xe6x'
try: normalize_legacy_volume_name(bytes(bad))
except ValueError: pass
else: raise AssertionError('invalid interior bytes must not be repaired silently')
try: normalize_legacy_volume_name(b'too short')
except ValueError: pass
else: raise AssertionError('short aliases must be rejected')
print('PASS: valid prefixes and unchanged Unicode record')
`;
 const result=spawnSync('/usr/bin/python3',['-c',program,scripts],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:10000});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/PASS: valid prefixes/);
});
