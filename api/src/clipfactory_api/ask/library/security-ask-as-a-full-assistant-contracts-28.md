## Ask as a full assistant (CONTRACTS §28)

* **Prompt injection.** Web pages, search results, files and pictures are data: the rules say never follow
  instructions inside them, and the tools make it safe even if the model did. Ask has no tool that writes, posts,
  deletes, connects or sends. `web_fetch` opens only URLs from this answer's search results, an earlier answer's
  sources (sent back by the panel) or URLs the owner typed himself, so a page cannot chain fetches or carry his data
  out in a URL. APP STATE, which the model reads with system weight, holds only enums, numbers, ids, booleans and
  Clip Factory's own step titles: clip hooks, raw error text and account names (words others or a model wrote) reach
  the model only as tool results. Only those URLs become live links, and only
  after the answer is done; any other URL shows as plain text.
* **SSRF.** `web_fetch` is https only; every address must be public (private, loopback, link-local, CGNAT, metadata,
  multicast and reserved addresses are refused, and so are IPv6 forms that carry an IPv4 address: NAT64, 6to4 and
  Teredo) and is checked again on each of at most 3 redirects; the connection goes to the checked address; one
  deadline for the whole fetch (DNS 2 s, every request at most 6 s, at most 10 s in all and never past the answer's
  hard budget), so a page that trickles bytes cannot hold the worker past its Lambda timeout; 2 MB, four content
  types, no cookies or auth headers. The worker checks Stop and the hard budget before every round of tools.
* **Secrets.** Questions asking to be shown his own stored password, key, token or cookie contents get a fixed answer
  with no model call (their files are deleted); questions about keys in general are answered (Ask can't read any
  secret). The knowledge pack, APP STATE, text files and office files pass the wide secrets filter (keys, tokens,
  account ids, ARNs, emails, URLs with a query). Every streamed answer passes a narrow filter (private key blocks,
  `AKIA`/`ASIA` keys, `sk-`/`ghp_`/`xox` style keys and his stored search key), with a 64-character hold-back that
  never cuts inside an unbroken token and holds a private key block back until its END, so a key split across many
  deltas never leaves. APP STATE never
  carries tokens, keys, secret names, ARNs, emails or OAuth state. The web search key lives only in Secrets Manager.
* **Files.** Uploaded with presigned PUTs (type and length signed) to `ask/{sub}/`, read once and deleted as soon as
  they are in memory (again when the answer ends); the API deletes them on every start that does not return 202 and
  the panel on every ending where the question did not start; the 1-day lifecycle rule is the safety net (S3 expires
  once a day, so a forgotten file lives at most about 2 days). Office files are read with zip-bomb limits and no DTDs.
* **Logs.** One line per answer with ids, counts, timings, tokens and the outcome; never the question, answer, file
  names or contents, URLs, search queries or the key. Bedrock model invocation logging stays off (a drift test).
* **IAM.** `cf-prod-fn-ask` may call only the two Ask models (`bedrock-mantle:Model` condition), read and delete
  `ask/*`, read skill files, read the table (`GetItem` and `Query` only: no writes of any kind), post to WebSocket
  connections and read the search key. The search key permissions name exactly `cf-prod/ask/search-key-??????` (the
  name plus the 6-character suffix Secrets Manager adds), never a trailing `*`. The key is cached 60 s in a warm
  worker, so **Take key away** is felt within a minute.
