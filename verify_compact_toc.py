from docx import Document
from zipfile import ZipFile
from docx.oxml.ns import qn
import sys

path = sys.argv[1]
with ZipFile(path) as archive:
    assert archive.testzip() is None
    xml = archive.read('word/document.xml').decode('utf-8')
    assert xml.count('PAGEREF toc_entry_') == 23
    assert 'w:val="nil"' in xml

document = Document(path)
toc = next(table for table in document.tables if len(table.columns) == 2 and len(table.rows) == 23)
assert all(row.cells[0].text.strip() for row in toc.rows)
assert all(cell._tc.tcPr.find(qn('w:shd')) is None for row in toc.rows for cell in row.cells)
assert len(document.sections) == 3
print('PASS: 23-entry compact invisible TOC, dynamic page references, pagination sections, and DOCX integrity verified.')
