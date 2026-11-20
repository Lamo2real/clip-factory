## ADR-38 BM25 over vectors for help, and the model is optional

- **Context.** The owner wants a helper that answers "how do I…" and "where is…" in steps a child can follow and then
  shows the button. The knowledge is small (a few hundred short docs generated from the app's own code plus about 40
  guides), English only, full of exact UI words (**Upload**, **Throw away**, **Click sound**), and it changes with every
  UI change. A wrong answer ("press Publish", a page that does not exist) is worse than "I don't know".
- **Decision.** Retrieval is an in-memory **BM25** ranker (k1 1.2, b 0.75; title and keywords weighted highest; shared
  synonyms, a light stemmer and one-edit typo matching), implemented twice with the same rules (Python in the API,
  TypeScript in the browser) and checked against one shared eval file of at least 44 Clip Factory questions. A match
  must pass a minimum score, cover half the content words and hit a title or keyword, else the answer is a fixed "I
  don't know that one yet.". A composer turns the best match into the full answer. **The model is optional**: Claude
  Haiku only rewrites that answer, and any model output that names a button, path or number not found in the matches
  is replaced by the composed answer.
- **Alternatives.** *Embeddings in S3 Vectors* (already deployed for the learning memory, ADR-25) or *a Bedrock
  Knowledge Base*: an embedding call per question and per corpus change, a vector index to keep in sync with every
  deploy, fuzzy similarity that blurs exact button names ("Keep" vs "Keep going"), harder to test offline and to
  explain when it is wrong; a Knowledge Base also bills a standing vector store. *Let the model answer from the whole
  corpus* (bigger prompts, invented steps, nothing to fall back on when it fails). *A static FAQ page* (no navigation,
  no spotlight, goes stale). *Model required* (every Bedrock hiccup, Marketplace subscription gap or cap would break
  help).
- **Consequences.** Help works with the model off, capped, slow or broken, and in the browser when the API is down. It
  costs nothing per question without the model, is deterministic and testable offline, and an unknown or refused
  question never costs a model call. Synonyms and keywords have to be curated for wording BM25 cannot bridge ("make it
  calmer" → Reduce motion); the eval file is the guard. The two retrievers must stay identical, which the shared eval
  file checks in both CI jobs.
