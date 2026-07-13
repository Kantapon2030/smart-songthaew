from docx import Document
import sys

document = Document(sys.argv[1])
for i, section in enumerate(document.sections):
    print(f'Section {i}: different_first={section.different_first_page_header_footer}')
    for name, footer in (
        ('default', section.footer),
        ('first', section.first_page_footer),
        ('even', section.even_page_footer),
    ):
        print(f'  {name}: linked={footer.is_linked_to_previous}; text={repr(" | ".join(p.text for p in footer.paragraphs))}')
