from docx import Document
import sys

doc = Document(sys.argv[1])
for index, paragraph in enumerate(doc.paragraphs):
    text = paragraph.text.strip().replace('\n', ' / ')
    runs = [run for run in paragraph.runs if run.text.strip()]
    if not text or len(text) >= 150 or not runs:
        continue
    bold = any(run.bold for run in runs)
    size = max((run.font.size.pt if run.font.size else 0 for run in runs), default=0)
    if bold or size >= 15:
        print(f'{index} | bold={bold} size={size:g} | {text}')
