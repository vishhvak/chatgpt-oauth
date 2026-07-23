import { Audio } from "@remotion/media";
import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Blossom } from "./Blossom";
import { DIM, INK, MONO, SANS, WHITE } from "./theme";

// 6.5s · 195 frames · three shots cut to the track:
// button+press → four installs stagger → lockup on the ~5s hit.
const SHOT2 = 55;
const SHOT3 = 150;
const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);

// every frame an SFX lands — the music ducks around each of these
const SFX_HITS = [1, 26, SHOT2 + 2, SHOT2 + 13, SHOT2 + 22, SHOT2 + 31, SHOT2 + 40, SHOT3 + 1];

const ButtonShot: React.FC = () => {
  const frame = useCurrentFrame();
  const PRESS = 26;
  const press = interpolate(frame, [PRESS, PRESS + 4, PRESS + 8, PRESS + 18], [1, 0.95, 0.95, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.3, 0, 0.2, 1),
  });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 28,
          background: WHITE,
          border: "3px solid #E2E2E2",
          borderRadius: 999,
          padding: "44px 70px",
          boxShadow: "0 2px 18px rgba(0,0,0,0.06)",
          opacity: interpolate(frame, [0, 8], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          scale: String(
            press *
              interpolate(frame, [0, 12], [0.9, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: EASE_OUT,
              }),
          ),
        }}
      >
        <Blossom size={66} />
        <div
          style={{
            fontFamily: SANS,
            fontWeight: 700,
            fontSize: 58,
            color: INK,
            letterSpacing: "-0.01em",
          }}
        >
          Sign in with ChatGPT
        </div>
      </div>
    </AbsoluteFill>
  );
};

const INSTALLS: { label: string; cmd: string }[] = [
  { label: "TypeScript", cmd: "pnpm add chatgpt-oauth" },
  { label: "Python", cmd: "pip install chatgpt-oauth" },
  { label: "Swift", cmd: "SwiftPM · ChatGPTOAuth" },
  { label: "Kotlin", cmd: "Gradle · chatgpt-oauth-core" },
];

const InstallShot: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 44 }}
    >
      <div
        style={{
          fontFamily: SANS,
          fontWeight: 700,
          fontSize: 64,
          color: INK,
          letterSpacing: "-0.02em",
          opacity: interpolate(frame, [0, 8], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          marginBottom: 10,
        }}
      >
        Their ChatGPT. Your app.
      </div>
      {/* one left-aligned block so the label/command seam is a straight vertical line */}
      <div style={{ display: "flex", flexDirection: "column", gap: 44, alignItems: "flex-start" }}>
      {INSTALLS.map((row, i) => (
        <div
          key={row.label}
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 34,
            opacity: interpolate(frame, [12 + i * 9, 20 + i * 9], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            translate: `0px ${interpolate(frame, [12 + i * 9, 22 + i * 9], [16, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: EASE_OUT,
            })}px`,
          }}
        >
          <div
            style={{
              fontFamily: SANS,
              fontWeight: 700,
              fontSize: 34,
              color: DIM,
              width: 210,
              textAlign: "right",
            }}
          >
            {row.label}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 38, color: INK }}>{row.cmd}</div>
        </div>
      ))}
      </div>
    </AbsoluteFill>
  );
};

const LockupShot: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 34 }}
    >
      <div
        style={{
          fontFamily: SANS,
          fontWeight: 700,
          fontSize: 104,
          color: INK,
          letterSpacing: "-0.03em",
          opacity: interpolate(frame, [0, 6], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          scale: String(
            interpolate(frame, [0, 10], [1.06, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: EASE_OUT,
            }),
          ),
        }}
      >
        chatgpt-oauth
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 36,
          color: DIM,
          opacity: interpolate(frame, [8, 16], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        github.com/vishhvak/chatgpt-oauth
      </div>
    </AbsoluteFill>
  );
};

export const Short: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: WHITE }}>
      <Sequence name="Button" from={0} durationInFrames={SHOT2}>
        <ButtonShot />
      </Sequence>
      <Sequence name="Installs" from={SHOT2} durationInFrames={SHOT3 - SHOT2}>
        <InstallShot />
      </Sequence>
      <Sequence name="Lockup" from={SHOT3} durationInFrames={195 - SHOT3}>
        <LockupShot />
      </Sequence>

      {/* track is time-stretched to exactly the video length, so its own ending
          lands on the last frame; ducked a touch under every SFX hit */}
      <Audio
        src={staticFile("track.mp3")}
        volume={(f) => {
          const base = interpolate(f, [0, 4, 186, 195], [0, 0.9, 0.9, 0.6], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const duck = SFX_HITS.reduce(
            (lowest, hit) =>
              Math.min(
                lowest,
                interpolate(f, [hit - 2, hit, hit + 5, hit + 10], [1, 0.55, 0.55, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              ),
            1,
          );
          return base * duck;
        }}
      />
      {/* button entrance pop + a crisp real mouse click on the press */}
      <Sequence name="Button pop" from={1} durationInFrames={12}>
        <Audio src={staticFile("sfx/pop-low.wav")} volume={0.55} />
      </Sequence>
      <Sequence name="Press click" from={26} durationInFrames={14}>
        <Audio src={staticFile("sfx/key-heavy.wav")} volume={0.95} />
      </Sequence>

      {/* asmr pops as each text lands: headline, then a rising ladder per install row */}
      <Sequence name="Headline pop" from={SHOT2 + 2} durationInFrames={12}>
        <Audio src={staticFile("sfx/pop-1.wav")} volume={0.5} />
      </Sequence>
      {[0, 1, 2, 3].map((i) => (
        <Sequence
          key={i}
          name={`Row pop ${i + 1}`}
          from={SHOT2 + 13 + i * 9}
          durationInFrames={12}
        >
          <Audio src={staticFile(`sfx/pop-${i + 1}.wav`)} volume={0.62} />
        </Sequence>
      ))}

      {/* lockup lands deep */}
      <Sequence name="Lockup pop" from={SHOT3 + 1} durationInFrames={12}>
        <Audio src={staticFile("sfx/pop-low.wav")} volume={0.7} />
      </Sequence>
    </AbsoluteFill>
  );
};
