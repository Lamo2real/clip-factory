// A reference video's player (docs/CONTRACTS.md §45.28) in Stories' own look: the video in the hero's bezel, and under
// it on the same glass, in place of the browser's grey strip, a scrubber with the orange fill, then a round orange
// play button, the time, and sound and full screen as round glass buttons. Every control is a real button or the
// browser's own range (Tab to it, Space or Enter, the arrow keys to move through the video); a tap on the video plays
// or pauses it too. Full screen is the browser's own, with its own controls there. A video that will not play (a
// link that ran out, a file the browser cannot read) says so in place of the controls, with Try again.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { RoundGlassButton } from "../../glass/index.ts";
import { Btn, clock, Icon } from "../kit.tsx";

/** What the player says when the video will not play: first a plain retry, then (it failed again) a reload. */
export const PLAY_FAILED = "This video would not play.";
export const PLAY_FAILED_AGAIN = "This video would not play. Reload the page to try again.";

export function RefPlayer({ videoRef, src, title, onRetry }: { videoRef: RefObject<HTMLVideoElement | null>; src: string; title: string; onRetry?: () => void }) {
  // 0 while it plays (or may); 1 once it would not play; 2 once it would not play after Try again too.
  const [failed, setFailed] = useState(0);
  const tried = useRef(false);
  // A new link (the page read the video again) gets its own try.
  useEffect(() => setFailed(0), [src]);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [muted, setMuted] = useState(false);

  const sync = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setPlaying(!v.paused && !v.ended);
    setTime(Number.isFinite(v.currentTime) ? v.currentTime : 0);
    setLength(Number.isFinite(v.duration) ? v.duration : 0);
    setMuted(v.muted);
  }, [videoRef]);

  // The browser's own controls only while its full screen is on (it has nothing else there); Stories' strip after.
  useEffect(() => {
    const change = () => {
      const v = videoRef.current;
      if (v) v.controls = document.fullscreenElement === v;
    };
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, [videoRef]);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play?.()?.catch(() => undefined);
    else v.pause?.();
  };
  const full = () => {
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!v) return;
    if (v.requestFullscreen) void v.requestFullscreen().catch(() => undefined);
    else v.webkitEnterFullscreen?.();
  };
  const mute = () => {
    const v = videoRef.current;
    if (v) v.muted = !v.muted;
  };
  const retry = () => {
    tried.current = true;
    setFailed(0);
    onRetry?.();
    videoRef.current?.load?.();
  };
  const at = length > 0 ? Math.min(time, length) : 0;
  const filled = length > 0 ? `${(at / length) * 100}%` : "0%";

  return (
    <>
      <video
        ref={videoRef}
        className="st-ref-player__video"
        src={src}
        playsInline
        preload="metadata"
        aria-label={`Play ${title}`}
        onClick={toggle}
        onPlay={sync}
        onPause={sync}
        onEnded={sync}
        onTimeUpdate={sync}
        onSeeked={sync}
        onLoadedMetadata={sync}
        onDurationChange={sync}
        onVolumeChange={sync}
        onError={() => setFailed(tried.current ? 2 : 1)}
        onLoadedData={() => {
          tried.current = false;
        }}
      />
      {failed ? (
        <div className="st-ref-controls st-ref-controls--failed" role="alert">
          <p className="st-ref-controls__failed">{failed === 2 ? PLAY_FAILED_AGAIN : PLAY_FAILED}</p>
          {/* Glass, not orange: the page keeps its own one main action (Use in a video, Analyze it). */}
          <Btn icon="retry" onClick={retry}>
            Try again
          </Btn>
        </div>
      ) : (
        <div className="st-ref-controls">
          <input
            type="range"
            className="st-ref-seek"
            min={0}
            max={length > 0 ? length : 1}
            step={0.1}
            value={at}
            aria-label="Where in the video"
            aria-valuetext={`${clock(at)} of ${clock(length)}`}
            style={{ "--st-chat-seek": filled } as CSSProperties}
            onChange={(e) => {
              const v = videoRef.current;
              if (!v || !(length > 0)) return;
              v.currentTime = Number(e.target.value);
              setTime(v.currentTime);
            }}
          />
          <div className="st-ref-controls__row">
            <RoundGlassButton tone="accent" title="" label={playing ? "Pause" : "Play"} onClick={toggle}>
              <Icon name={playing ? "pause" : "play"} size={20} />
            </RoundGlassButton>
            <span className="st-ref-controls__time" aria-hidden="true">
              {/* As wide as the length's clock: 0 is the widest digit, so the time never pushes " / 0:45" about. */}
              <span className="st-ref-controls__now" style={{ minWidth: `${clock(length).length}ch` }}>
                {clock(at)}
              </span>{" "}
              / {clock(length)}
            </span>
            <RoundGlassButton title="" label={muted ? "Sound on" : "Sound off"} onClick={mute}>
              <Icon name={muted ? "muted" : "sound"} size={20} />
            </RoundGlassButton>
            <RoundGlassButton title="" label="Full screen" onClick={full}>
              <Icon name="expand" size={20} />
            </RoundGlassButton>
          </div>
        </div>
      )}
    </>
  );
}
