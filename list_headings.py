from docx import Document
import sys

doc = Document(sys.argv[1])
for paragraph in doc.paragraphs:
    if paragraph.style.name.startswith('Heading'):
        print(f'{paragraph.style.name}: {paragraph.text.strip()}')
