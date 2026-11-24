"""
Repairs math-symbol glyph names in a PDF so the text layer decodes them
(rag-stack Phase 3, experiment p3-glyph-repair).

The KSSM Maths textbooks set operators and inequality signs in Adobe
"Mathematical Pi" fonts with no ToUnicode map. Each subset names its glyphs in
an /Encoding /Differences array with Adobe's private names (H20669, H33355, ...),
which pdftotext cannot map, so it falls back to the raw code: "!", '"', "#".
The same code means a different symbol in each subset — "!" is ∩ in one font
and ≤ in the next — so the text cannot be repaired after extraction. Renaming
the glyphs to uniXXXX names in a copy of the PDF lets poppler decode them.

Only names whose meaning was confirmed against the book's own prose are mapped
(e.g. H20669 in "Set P ∩ Q is written using the symbol ∩"); unknown names are
left alone rather than guessed.

    python3 src/rag/repair_glyphs.py <in.pdf> <out.pdf>
"""
import re
import sys

import fitz  # PyMuPDF

MATH_PI = {
    "H20669": "uni2229",  # ∩
    "H20668": "uni222A",  # ∪
    "H20666": "uni2282",  # ⊂
    "H33355": "uni2264",  # ≤
    "H33356": "uni2265",  # ≥
    "H11021": "less",     # <
    "H11022": "greater",  # >
}


def repair(src: str, dst: str) -> int:
    doc = fitz.open(src)
    changed = 0
    for xref in range(1, doc.xref_length()):
        try:
            kind, diffs = doc.xref_get_key(xref, "Encoding/Differences")
        except Exception:  # a malformed object (seen in a Chemistry textbook) is not a font to repair
            continue
        if kind != "array" or "/H" not in diffs:
            continue
        fixed = re.sub(r"/(H\d+)", lambda m: "/" + MATH_PI.get(m.group(1), m.group(1)), diffs)
        if fixed != diffs:
            doc.xref_set_key(xref, "Encoding/Differences", fixed)
            changed += 1
    if changed:  # nothing to repair -> no copy (some PDFs cannot be re-saved by MuPDF at all)
        doc.save(dst, garbage=0, deflate=True)
    return changed


if __name__ == "__main__":
    n = repair(sys.argv[1], sys.argv[2])
    print(f"{n} font encodings repaired -> {sys.argv[2]}")
