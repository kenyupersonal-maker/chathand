#!/usr/bin/env python3
"""Read-only bounded document adapters. No macros, formulas, links or code execute."""
import sys, os, json, zipfile, posixpath, re, csv, plistlib, base64
from xml.etree import ElementTree as ET
MAX_MEMBER=16*1024*1024
MAX_TOTAL=64*1024*1024
NS={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

def bounded_xml(data):
    if len(data)>MAX_MEMBER or b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('DOCUMENT_XML_LIMIT')
    return ET.fromstring(data)

def archive(stream):
    z=zipfile.ZipFile(stream)
    items=z.infolist()
    if len(items)>10000 or sum(i.file_size for i in items)>MAX_TOTAL:
        raise ValueError('DOCUMENT_ARCHIVE_LIMIT')
    for i in items:
        if i.file_size>MAX_MEMBER or (i.file_size>1024*1024 and i.file_size/max(i.compress_size,1)>500):
            raise ValueError('DOCUMENT_ARCHIVE_LIMIT')
    return z

def read_docx(stream,o):
    with archive(stream) as z:
        tree=bounded_xml(z.read('word/document.xml'))
        blocks=[]
        for p in tree.findall('.//w:body/w:p',NS):
            text=''.join(t.text or '' for t in p.findall('.//w:t',NS))
            if text: blocks.append({'type':'paragraph','text':text[:12000]})
        # Tables are returned separately instead of implying faithful page layout.
        tables=[]
        for table in tree.findall('.//w:body/w:tbl',NS)[:100]:
            rows=[]
            for row in table.findall('w:tr',NS)[:200]:
                rows.append([''.join(t.text or '' for t in cell.findall('.//w:t',NS))[:4000] for cell in row.findall('w:tc',NS)[:100]])
            tables.append(rows)
        start=o.get('offset',0);limit=o.get('limit',100)
        return {'format':'docx','paragraphs':blocks[start:start+limit],'tables':tables if start==0 else [],'total_paragraphs':len(blocks),'next_offset':start+limit if start+limit<len(blocks) else None,'note':'Text and tables only; pagination, drawings, headers and layout are not reproduced.'}

def column(s):
    n=0
    for c in s: n=n*26+ord(c)-64
    return n

def read_xlsx(stream,o):
    with archive(stream) as z:
        wb=bounded_xml(z.read('xl/workbook.xml'));rels=bounded_xml(z.read('xl/_rels/workbook.xml.rels'))
        links={r.attrib['Id']:r.attrib['Target'] for r in rels if r.attrib.get('TargetMode')!='External'}
        sheets=[]
        for s in wb.findall('s:sheets/s:sheet',NS):
            rid=s.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
            target=links.get(rid,'')
            resolved=posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl',target))
            if not resolved.startswith('xl/') or '..' in resolved.split('/'): raise ValueError('SHEET_PATH_INVALID')
            sheets.append({'name':s.attrib['name'],'file':resolved})
        chosen=o.get('sheet',sheets[0]['name'] if sheets else '')
        sheet=next((s for s in sheets if s['name']==chosen),None)
        if sheet is None: raise ValueError('SHEET_MISSING')
        match=re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]*):([A-Z]{1,3})([1-9][0-9]*)',o.get('range','A1:Z100').upper())
        if not match: raise ValueError('RANGE_INVALID')
        a,b,c,d=match.groups();c1,c2,r1,r2=column(a),column(c),int(b),int(d)
        if c2<c1 or r2<r1 or c2>16384 or r2>1048576 or (r2-r1+1)*(c2-c1+1)>10000: raise ValueError('RANGE_LIMIT')
        shared=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            strings=bounded_xml(z.read('xl/sharedStrings.xml'))
            shared=[''.join(t.text or '' for t in si.findall('.//s:t',NS))[:8000] for si in strings]
        data=[[None]*(c2-c1+1) for _ in range(r2-r1+1)];formulas=[]
        tree=bounded_xml(z.read(sheet['file']))
        for cell in tree.findall('.//s:sheetData/s:row/s:c',NS):
            m=re.fullmatch(r'([A-Z]+)([0-9]+)',cell.attrib.get('r',''))
            if not m: continue
            col,row=column(m[1]),int(m[2])
            if not (c1<=col<=c2 and r1<=row<=r2): continue
            v=cell.find('s:v',NS);value=v.text if v is not None else None;kind=cell.attrib.get('t')
            if kind=='s' and value is not None: value=shared[int(value)]
            elif kind=='inlineStr': value=''.join(t.text or '' for t in cell.findall('.//s:t',NS))[:8000]
            elif kind=='b' and value is not None: value=value=='1'
            elif kind not in ('str','e','d') and value is not None:
                try: value=float(value) if any(x in value.lower() for x in ('.','e')) else int(value)
                except ValueError: pass
            f=cell.find('s:f',NS)
            if f is not None: formulas.append({'cell':cell.attrib['r'],'formula':f.text or '','cached_value':value})
            data[row-r1][col-c1]=value
        return {'format':'xlsx','sheets':[s['name'] for s in sheets],'sheet':chosen,'range':o.get('range','A1:Z100'),'values':data,'formulas':formulas,'note':'Values are stored/cached data, not recalculated. Date serials, merged cells and styles are not converted.'}

def safe_value(v):
    if isinstance(v,bytes): return {'type':'blob','bytes':len(v),'base64':base64.b64encode(v[:1024]).decode(),'truncated':len(v)>1024}
    if isinstance(v,(int,float,str,bool)) or v is None: return v
    if isinstance(v,dict): return {str(k):safe_value(x) for k,x in v.items()}
    if isinstance(v,list): return [safe_value(x) for x in v]
    return str(v)

def main():
    o=json.loads(sys.argv[1]);fmt=o['format']
    with os.fdopen(os.dup(3),'rb') as stream:
        if fmt=='docx': return read_docx(stream,o)
        if fmt=='xlsx': return read_xlsx(stream,o)
        if fmt=='plist': return {'format':'plist','value':safe_value(plistlib.load(stream))}
        if fmt=='csv':
            import io
            text=io.TextIOWrapper(stream,encoding=o.get('encoding','utf-8-sig'),newline='')
            start=o.get('offset',0);limit=o.get('limit',100);rows=[]
            for i,row in enumerate(csv.reader(text)):
                if i>=start: rows.append([v[:8000] for v in row[:200]])
                if len(rows)>limit: break
                if i>1000000: raise ValueError('CSV_SCAN_LIMIT')
            return {'format':'csv','rows':rows[:limit],'next_offset':start+limit if len(rows)>limit else None}
        raise ValueError('FORMAT_UNSUPPORTED')
try:
    result=main();encoded=json.dumps(result,ensure_ascii=False)
    if len(encoded.encode())>1024*1024: raise ValueError('OUTPUT_LIMIT_USE_SMALLER_RANGE')
    print(encoded)
except Exception as e:
    print(json.dumps({'error':{'code':'DOCUMENT_READ_FAILED','detail':str(e)[:300]}},ensure_ascii=False))
    sys.exit(1)
