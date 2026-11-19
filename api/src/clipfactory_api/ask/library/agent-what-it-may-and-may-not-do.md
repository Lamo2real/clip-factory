## What it may and may not do

- It **may** read the job, the owner's settings, every skill and learnings (including the "Best of week" ones); query and write clip vectors in
  S3 Vectors; download the source (the sound, a small copy of the picture for watching, and the sections it cuts);
  call Transcribe and Bedrock (Claude Fable 5.1, Amazon Nova 2 Lite as a second watcher, Titan Text Embeddings V2);
  send frames and small video parts of the source to those two models so they can watch it; run ffmpeg; write clips
  to S3 and Clip items to DynamoDB; update the job's status, steps and progress; and send its job flow callback
  (heartbeat, success, failure).
- It **never** publishes anything, never changes settings or skills, and never reads the YouTube cookies for anything
  but yt-dlp. Publishing happens only after the owner's Confirm, in the durable `cf-prod-clip-flow`.
- It **never** calls a service the deep analysis rejected (Rekognition, Comprehend, MediaConvert, Step Functions,
  Batch): its role has no action for them ([ADR-40](DECISIONS.md#adr-40-watch-the-whole-video-before-picking)).
