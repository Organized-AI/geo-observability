# Phase G1 complete: public repo hygiene

- The research notes are no longer in the repo. `SPECIFICATIONS/llm-tracing-design.md` replaces them and holds only our own design and data contracts.
- The branch history was rewritten before its first push, so no commit on `feat/llm-tracing` contains the notes. Milestone tags were moved to the rewritten commits.
- The original notes are kept outside the repo, in the owner's private documents.
- Check: `git log origin/main..HEAD -p` has no competitor product names.
