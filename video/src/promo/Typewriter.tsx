import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { INK } from "./theme";

export type Chunk = { text: string; color?: string };

/**
 * Types chunks character-by-character behind a block caret, the way the
 * reference film does: linear char rate, hard block caret, steps blink once idle.
 */
export const Typewriter: React.FC<{
  chunks: Chunk[];
  /** frame (within the parent sequence) when typing starts */
  from: number;
  /** frames the typing occupies */
  duration: number;
  fontSize: number;
  fontWeight?: number;
  fontFamily: string;
  /** hide the caret entirely once typing is done for n frames (0 = keep blinking) */
  caret?: boolean;
  align?: "center" | "left";
  lineHeight?: number;
}> = ({
  chunks,
  from,
  duration,
  fontSize,
  fontWeight = 700,
  fontFamily,
  caret = true,
  align = "center",
  lineHeight = 1.18,
}) => {
  const frame = useCurrentFrame();
  const total = chunks.reduce((n, c) => n + c.text.length, 0);
  const shown = Math.floor(
    interpolate(frame, [from, from + duration], [0, total], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );
  const done = shown >= total;
  const blinkOn = done ? Math.floor(frame / 16) % 2 === 0 : true;

  let used = 0;
  return (
    <div
      style={{
        fontFamily,
        fontSize,
        fontWeight,
        lineHeight,
        letterSpacing: "-0.02em",
        color: INK,
        textAlign: align,
        whiteSpace: "pre-wrap",
      }}
    >
      {chunks.map((chunk, i) => {
        const visible = Math.max(0, Math.min(chunk.text.length, shown - used));
        used += chunk.text.length;
        return (
          <span key={i} style={{ color: chunk.color ?? INK }}>
            {chunk.text.slice(0, visible)}
          </span>
        );
      })}
      {caret && frame >= from && (
        <span
          style={{
            display: "inline-block",
            width: fontSize * 0.14,
            height: fontSize * 0.78,
            background: INK,
            marginLeft: fontSize * 0.06,
            verticalAlign: "baseline",
            translate: `0px ${fontSize * 0.1}px`,
            opacity: blinkOn ? 1 : 0,
          }}
        />
      )}
    </div>
  );
};
