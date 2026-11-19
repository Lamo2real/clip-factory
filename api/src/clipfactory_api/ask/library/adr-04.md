## ADR-04 Amazon Transcribe instead of local Whisper

- **Context.** The local app used Whisper on the Mac. In the cloud, Whisper would need a large CPU container or a GPU.
- **Decision.** Amazon Transcribe batch jobs with word timestamps and automatic language detection, reading
  `audio.m4a` from the media bucket and writing `transcript.json` back.
- **Alternatives.** Whisper in the agent container (slow on CPU, a heavy image); a SageMaker endpoint (always-on cost).
- **Consequences.** About $0.006 per minute of audio ($0.0001 per second in the AWS price list for eu-north-1, checked
  2026-11-17; the $0.024 this record carried before was a stale figure). No model to maintain. Transcription runs while the agent waits,
  so long streams finish faster than on a laptop.
