"""Repair zero-size form XObject bounding boxes so pages render.

Textbook Physics Form 4 (Malay) and Textbook Kimia Form 4 (BM) wrap each page's
content in a form XObject declared with /BBox [0 0 0 0]. Renderers clip a form
to its BBox, so poppler and MuPDF both draw those pages pure white (237/268 and
205/275 pages); text extraction ignores clipping, which is why the text layer
was fine. Setting each zero BBox to the page's MediaBox makes the page render.
Only rendering changes — the text and the content streams are untouched.

    python3 src/rag/repair_bbox.py <in.pdf> <out.pdf>
    python3 src/rag/repair_bbox.py <in.pdf> --render <dir> [dpi]

--render writes p-NNN.jpg pages straight from the repaired document in memory
(the names pdftoppm uses), for a PDF PyMuPDF cannot save back: Textbook Kimia
Form 4 (BM) fails to save with "invalid key in dict".
"""
import sys
import fitz

src, dst = sys.argv[1], sys.argv[2]
render_dir = sys.argv[3] if dst == "--render" else None
doc = fitz.open(src)
fixed = 0
for page in doc:
    r = page.mediabox
    for xref, _name, _parent, _bbox in page.get_xobjects():
        try:
            typ = doc.xref_get_key(xref, "Subtype")[1]
            bbox = doc.xref_get_key(xref, "BBox")[1]
        except Exception:
            continue
        if typ == "/Form" and bbox.replace(" ", "") == "[0000]":
            doc.xref_set_key(xref, "BBox", f"[{r.x0} {r.y0} {r.x1} {r.y1}]")
            fixed += 1
print(f"{src}: {fixed} zero BBoxes set to the page box")
if render_dir:
    import os
    os.makedirs(render_dir, exist_ok=True)
    dpi = int(sys.argv[4]) if len(sys.argv) > 4 else 150
    width = len(str(doc.page_count))
    for i, page in enumerate(doc):
        page.get_pixmap(dpi=dpi).save(os.path.join(render_dir, f"p-{str(i + 1).zfill(width)}.jpg"), jpg_quality=82)
    print(f"rendered {doc.page_count} pages to {render_dir}")
else:
    doc.save(dst, garbage=0, deflate=True)
