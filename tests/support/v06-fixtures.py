from pathlib import Path
import sys, zipfile, sqlite3, plistlib, base64
p=Path(sys.argv[1]);p.mkdir(parents=True,exist_ok=True)
(p/'large.txt').write_text('中文测试 alpha\n'*50000,encoding='utf-8')
(p/'gbk.txt').write_bytes('你好，Ken Bridge。'.encode('gbk'))
(p/'utf16.txt').write_bytes('你好，跨平台文件。'.encode('utf-16le'))
(p/'rows.csv').write_text('名称,值\n测试,42\n逗号,"a,b"\n',encoding='utf-8')
(p/'config.plist').write_bytes(plistlib.dumps({'name':'Ken Bridge','enabled':True},fmt=plistlib.FMT_BINARY))
(p/'image.png').write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII='))
with zipfile.ZipFile(p/'document.docx','w') as z:
    z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Ken 文档测试</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格值</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
with zipfile.ZipFile(p/'book.xlsx','w') as z:
    z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>')
    z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
    z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>数量</t></is></c><c r="B1"><v>42</v></c></row><row r="2"><c r="B2"><f>B1*2</f><v>84</v></c></row></sheetData></worksheet>')
with zipfile.ZipFile(p/'bad.docx','w') as z:
    z.writestr('word/document.xml','<!DOCTYPE x [<!ENTITY ex SYSTEM "file:///nonexistent">]><x/>')
con=sqlite3.connect(p/'sample.sqlite');con.execute('CREATE TABLE records(name TEXT, amount INTEGER)');con.executemany('INSERT INTO records VALUES (?,?)',[('Ken',42),('Other',7)]);con.commit();con.close()
objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
stream=b'BT /F1 18 Tf 72 720 Td (Ken PDF test 42) Tj ET'
objects.append(b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream')
data=b'%PDF-1.4\n';offsets=[0]
for i,obj in enumerate(objects,1):offsets.append(len(data));data+=str(i).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
xref=len(data);data+=b'xref\n0 6\n0000000000 65535 f \n'+b''.join(('%010d 00000 n \n'%off).encode() for off in offsets[1:]);data+=b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(xref).encode()+b'\n%%EOF\n';(p/'document.pdf').write_bytes(data)
print('FIXTURES_READY')
