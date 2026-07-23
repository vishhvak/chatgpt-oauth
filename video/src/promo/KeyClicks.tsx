import { Audio } from "@remotion/media";
import React from "react";
import { Sequence, staticFile } from "remotion";

const SAMPLES = ["sfx/k1.wav", "sfx/k2.wav", "sfx/k3.wav", "sfx/k4.wav"];

/**
 * Emits one real keystroke sample per typed character (skipping whitespace),
 * on the SAME linear frame↔char mapping the Typewriter uses — so the sound
 * stops the instant the caret does.
 */
export const KeyClicks: React.FC<{
  text: string;
  /** frame (within the parent sequence) when typing starts — match the Typewriter */
  from: number;
  /** frames the typing occupies — match the Typewriter */
  duration: number;
  volume?: number;
}> = ({ text, from, duration, volume = 0.55 }) => {
  const total = text.length;
  const clicks: { frame: number; sample: string; gain: number }[] = [];
  let last = -2;
  for (let i = 0; i < total; i++) {
    if (/\s/.test(text[i])) continue; // no sound for spaces/newlines — reads as human
    const frame = Math.round(from + (i / total) * duration);
    if (frame <= last + 1) continue; // at most one click every 2 frames
    last = frame;
    // deterministic per-index variation — no Math.random in Remotion
    const h = (i * 2654435761) % 977;
    clicks.push({
      frame,
      sample: SAMPLES[h % SAMPLES.length],
      gain: volume * (0.8 + (h % 41) / 100),
    });
  }
  return (
    <>
      {clicks.map((c, i) => (
        <Sequence key={i} name={`key ${i}`} from={c.frame} durationInFrames={5}>
          <Audio src={staticFile(c.sample)} volume={c.gain} />
        </Sequence>
      ))}
    </>
  );
};
