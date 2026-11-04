# Provenance of the risk and control catalogs (PT34.1, S586)

The three catalogs a policy item's tags may name (PT8.6). Each was read on 2026-11-04 and built by a script that checks its counts and writes only printable ASCII. A catalog changes only in a commit that changes its file, its pin in `std/PINS.json` and this page together.

## `mit-ai-risk.json`: the MIT AI Risk Repository, Domain Taxonomy

Risk domains and subdomains: MIT AI Risk Repository, Domain Taxonomy, Version 4 (2025-12-04), airisk.mit.edu, licensed under CC BY 4.0.

- **Source.** The Domain Taxonomy of AI Risks as listed on https://airisk.mit.edu/risks, SHA-256 `f6e0c698fc9ccb55d71e80f0aa41411d56f5ce2ab8a20c7a3b3777bd14fb25e8` of the page as read.
- **Version.** Version 4, released 2025-12-04 (https://airisk.mit.edu/blog/repository-update-december-2025, SHA-256 `292bd28e4f9ddfe2b927c815ee26e0194193bb24100769cd7a58622e75543924`). The home page read the same day says that Version 4 is live (SHA-256 `d2c79c1c22c1fa2566d516462731162e4e266e82f712ff794a8dea973dcdb38a`). The release note describes the Domain Taxonomy as 7 domains and 24 subdomains, and the risks page lists the same 7 and 24, 7.6 Multi-agent risks among them (added in the April 2025 update).
- **What is stored.** The 7 domains and 24 subdomains, each with its number and the name the page gives it. No description is stored.
- **Licence.** CC BY 4.0. The names are copied with the attribution line above, which the risk report also prints (PT34.4, RT19).

## `nist-ai-rmf.json`: NIST AI RMF 1.0

- **Source.** The AI RMF Playbook data, https://airc.nist.gov/docs/playbook.json, SHA-256 `aecbee3d3c8820816d295b11d10fb61324b17c25c2ff39ee95e2aa5654555bba`, for the 72 subcategories and their text. NIST AI 100-1, *Artificial Intelligence Risk Management Framework (AI RMF 1.0)*, January 2023, https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf, SHA-256 `7576edb531d9848825814ee88e28b1795d3a84b435b4b797d3670eafdc4a89f1`, for the 19 categories. The 72 subcategory ids of the Playbook data and of the PDF are the same.
- **What is stored.** The 4 functions, the 19 categories and the 72 subcategories (19 under GOVERN, 18 under MAP, 22 under MEASURE, 13 under MANAGE). An id is written `FUNCTION-c` or `FUNCTION-c.s` (NIST writes `MANAGE 2.4`).
- **Edits to the text.** Curly quotes are straight. A dash that sets off an aside is written as parentheses or commas, as the house style asks. One category, GOVERN 4, is broken across a table cell in the PDF's text, and its end ("that considers and communicates AI risk.") is taken from the same page. No other word is changed.
- **Licence.** A work of the United States government, not subject to copyright in the United States.

## `iso-42001.json`: ISO/IEC 42001:2023, Annex A

- **Source.** The standard, ISO/IEC 42001:2023. Only its control ids are used, which are facts. They were checked against a public listing, https://riskprofs.com/iso-42001-annex-a-controls-list/, SHA-256 `0053924ea7019df23c3ebf88eccf30ea0aa0c97caf24eb5487acf630358aa65e` of the page as read: the 38 ids of the listing and of this catalog are the same.
- **What is stored.** The 9 objectives (A.2 to A.10), the two groups of A.6 (A.6.1, A.6.2) and the 38 controls, each with **a short label written for poly**. No label is the standard's title or text, and none was copied from the listing. A label names the subject of a control for a reader of a report; it is not the control, and the standard is the authority on what each control asks.
- **Licence.** The standard is copyrighted by ISO and IEC. Nothing of its text is stored.

## Conclusion

Each catalog says where it came from, which version it is and what was changed in it. The MIT names travel with their attribution, the NIST text is public, and the ISO entries are ids with poly's own words beside them.
