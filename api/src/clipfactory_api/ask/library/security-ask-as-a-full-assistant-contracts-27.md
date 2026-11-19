## Ask as a full assistant (CONTRACTS §27)

* **Prompt injection.** Web pages, search results, files and pictures are data: the rules say never follow
  instructions inside them, and the tools make it safe even if the model did. Ask has no tool that writes, posts,
  deletes, connects or sends. `web_fetch` opens only URLs from this answer's search results or URLs the owner typed
  himself, so a page cannot chain fetches or carry his data out in a URL. Only those URLs become live links, and only
  after the answer is done; any other URL shows as plain text.
* **SSRF.** `web_fetch` is https only; every address must be public (private, loopback, link-local, CGNAT, metadata,
  multicast and reserved addresses are refused) and is checked again on each of at most 3 redirects; the connection
  goes to the checked address; 6 s, 2 MB, four content types, no cookies or auth headers.
* **Secrets.** Questions asking to see or be told a password, key, token or cookie contents get a fixed answer with no
  model call (their files are deleted). The knowledge pack, text files (always .tfvars, .env, .pem) and every streamed
  answer pass a secrets filter (a 64-character hold-back catches a key split across two deltas). APP STATE never
  carries tokens, keys, secret names, ARNs, emails or OAuth state. The web search key lives only in Secrets Manager.
* **Files.** Uploaded with presigned PUTs (type and length signed) to `ask/{sub}/`, read once, deleted when the answer
  ends, with a 1-day lifecycle rule as a safety net. Office files are read with zip-bomb limits and no DTDs.
* **Logs.** One line per answer with ids, counts, timings, tokens and the outcome; never the question, answer, file
  names or contents, URLs, search queries or the key. Bedrock model invocation logging stays off (a drift test).
* **IAM.** `cf-prod-fn-ask` may call only the two Ask models (`bedrock-mantle:Model` condition), read and delete
  `ask/*`, read skill files, read the table (no Put or Delete), post to WebSocket connections and read the search key.
