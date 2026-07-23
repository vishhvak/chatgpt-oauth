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
import { KeyClicks } from "./KeyClicks";
import { DIM, GREEN, INK, MONO, SANS, WHITE } from "./theme";
import { Typewriter } from "./Typewriter";

// ---------- scene timing (30fps · 1440 frames · 48s) ----------
// No logo cold-open: this is not an OpenAI launch. The blossom appears only
// where it belongs — on the Sign in with ChatGPT button.
const S = {
  thesis: { from: 0, len: 210 },
  turn: { from: 210, len: 150 },
  button: { from: 360, len: 210 },
  code: { from: 570, len: 300 },
  langs: { from: 870, len: 210 },
  stats: { from: 1080, len: 150 },
  cta: { from: 1230, len: 210 },
} as const;

const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);

const THESIS_TEXT = "Your users already\npay for ChatGPT.";
const TURN_TEXT = "Why buy API credits\nto serve them?";
const CODE_A =
  "export const { GET, POST } =\n  toNextJsHandler(auth, {\n    secret: process.env.CHATGPT_OAUTH_SECRET!,\n    subject: async (req) =>\n      (await session(req)).user.id,\n  });";
const CODE_B =
  'const chatgpt = createChatGPT(auth, subject);\n\nstreamText({\n  model: chatgpt("gpt-5.4-mini"),\n});';
const LANGS_TEXT = "One protocol.\nFour implementations.";
const URL_TEXT = "github.com/vishhvak/chatgpt-oauth";

// code block A/B timing inside the Code scene
const CODE_A_TYPE = { from: 10, duration: 118 } as const;
const CODE_SWAP = 158; // crossfade midpoint between the two blocks
const CODE_B_TYPE = { from: 174, duration: 88 } as const;

// ---------- scenes ----------

const ThesisScene: React.FC = () => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 90 }}>
    {/* caret blinks alone for a beat, then types — the reference's cold open */}
    <Typewriter
      chunks={[
        { text: "Your users already\npay for " },
        { text: "ChatGPT", color: GREEN },
        { text: "." },
      ]}
      from={26}
      duration={100}
      fontSize={92}
      fontFamily={SANS}
    />
  </AbsoluteFill>
);

const TurnScene: React.FC = () => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 90 }}>
    <Typewriter
      chunks={[{ text: TURN_TEXT }]}
      from={8}
      duration={85}
      fontSize={92}
      fontFamily={SANS}
    />
  </AbsoluteFill>
);

const ButtonScene: React.FC = () => {
  const frame = useCurrentFrame();
  const PRESS = 120;
  const press = interpolate(
    frame,
    [PRESS, PRESS + 5, PRESS + 9, PRESS + 22],
    [1, 0.955, 0.955, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.3, 0, 0.2, 1) },
  );
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 64 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 26,
          background: WHITE,
          border: "2.5px solid #E2E2E2",
          borderRadius: 999,
          padding: "40px 64px",
          boxShadow: "0 2px 18px rgba(0,0,0,0.06)",
          opacity: interpolate(frame, [4, 22], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: EASE_OUT,
          }),
          translate: `0px ${interpolate(frame, [4, 26], [26, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: EASE_OUT,
          })}px`,
          scale: String(press),
        }}
      >
        <Blossom size={62} />
        <div
          style={{
            fontFamily: SANS,
            fontWeight: 700,
            fontSize: 54,
            color: INK,
            letterSpacing: "-0.01em",
          }}
        >
          Sign in with ChatGPT
        </div>
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 30,
          color: DIM,
          opacity: interpolate(frame, [150, 168], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        their subscription becomes your model access
      </div>
    </AbsoluteFill>
  );
};

const CodeBlock: React.FC<{
  chunks: { text: string; color?: string }[];
  from: number;
  duration: number;
}> = ({ chunks, from, duration }) => (
  <Typewriter
    align="left"
    chunks={chunks}
    from={from}
    duration={duration}
    fontSize={29}
    fontWeight={400}
    fontFamily={MONO}
    lineHeight={1.7}
  />
);

const CodeScene: React.FC = () => {
  const frame = useCurrentFrame();
  const aOpacity = interpolate(frame, [CODE_SWAP - 8, CODE_SWAP], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bOpacity = interpolate(frame, [CODE_SWAP, CODE_SWAP + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: 940 }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 26,
            color: DIM,
            marginBottom: 18,
            opacity: interpolate(frame, [0, 12], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          {frame < CODE_SWAP ? "app/api/chatgpt/[...chatgpt]/route.ts" : "chat.ts"}
        </div>
        <div
          style={{
            background: INK,
            borderRadius: 22,
            padding: "52px 56px",
            height: 460,
            position: "relative",
            opacity: interpolate(frame, [0, 14], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: EASE_OUT,
            }),
          }}
        >
          <div style={{ position: "absolute", inset: "52px 56px", opacity: aOpacity }}>
            {frame < CODE_SWAP && (
              <CodeBlock
                chunks={[
                  { text: "export const { GET, POST } =\n  ", color: "#EDEDED" },
                  { text: "toNextJsHandler", color: GREEN },
                  {
                    text: "(auth, {\n    secret: process.env.CHATGPT_OAUTH_SECRET!,\n    subject: async (req) =>\n      (await session(req)).user.id,\n  });",
                    color: "#EDEDED",
                  },
                ]}
                from={CODE_A_TYPE.from}
                duration={CODE_A_TYPE.duration}
              />
            )}
          </div>
          <div style={{ position: "absolute", inset: "52px 56px", opacity: bOpacity }}>
            {frame >= CODE_SWAP && (
              <CodeBlock
                chunks={[
                  { text: "const chatgpt = ", color: "#EDEDED" },
                  { text: "createChatGPT", color: GREEN },
                  { text: "(auth, subject);\n\nstreamText({\n  model: chatgpt(", color: "#EDEDED" },
                  { text: '"gpt-5.4-mini"', color: GREEN },
                  { text: "),\n});", color: "#EDEDED" },
                ]}
                from={CODE_B_TYPE.from}
                duration={CODE_B_TYPE.duration}
              />
            )}
          </div>
        </div>
        <div
          style={{
            fontFamily: SANS,
            fontWeight: 700,
            fontSize: 40,
            color: INK,
            textAlign: "center",
            marginTop: 44,
            letterSpacing: "-0.02em",
            opacity: interpolate(frame, [272, 288], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          That&apos;s the whole integration.
        </div>
      </div>
    </AbsoluteFill>
  );
};

const LangsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const langs = ["TypeScript", "Swift", "Python", "Kotlin"];
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 84 }}
    >
      <Typewriter
        chunks={[{ text: LANGS_TEXT }]}
        from={6}
        duration={80}
        fontSize={84}
        fontFamily={SANS}
        caret={false}
      />
      <div style={{ display: "flex", gap: 58 }}>
        {langs.map((lang, i) => (
          <div
            key={lang}
            style={{
              fontFamily: MONO,
              fontSize: 40,
              color: INK,
              opacity: interpolate(frame, [96 + i * 10, 110 + i * 10], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              translate: `0px ${interpolate(frame, [96 + i * 10, 112 + i * 10], [18, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: EASE_OUT,
              })}px`,
            }}
          >
            {lang}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const Stat: React.FC<{
  value: number;
  label: string;
  from: number;
  prefix?: string;
  color?: string;
  format?: boolean;
}> = ({ value, label, from, prefix = "", color = INK, format = false }) => {
  const frame = useCurrentFrame();
  const n = Math.round(
    interpolate(frame, [from, from + 46], [0, value], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.2, 0.8, 0.3, 1),
    }),
  );
  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          fontFamily: SANS,
          fontWeight: 700,
          fontSize: 120,
          color,
          letterSpacing: "-0.03em",
          whiteSpace: "nowrap",
          opacity: interpolate(frame, [from, from + 8], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        {prefix}
        {format ? n.toLocaleString("en-US") : n}
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 26,
          color: DIM,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          marginTop: 6,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
    </div>
  );
};

const StatsScene: React.FC = () => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
    {/* space-evenly across the full frame so no number can clip at the edges */}
    <div
      style={{
        display: "flex",
        width: "100%",
        justifyContent: "space-evenly",
        alignItems: "flex-start",
        padding: "0 40px",
      }}
    >
      <Stat value={4} label="apps rewired" from={8} />
      <Stat value={1143} label="tests green" from={20} format />
      <Stat value={349} label="lines deleted" from={32} prefix="−" color={GREEN} />
    </div>
  </AbsoluteFill>
);

const CtaScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 46 }}
    >
      <div
        style={{
          fontFamily: SANS,
          fontWeight: 700,
          fontSize: 96,
          color: INK,
          letterSpacing: "-0.03em",
          opacity: interpolate(frame, [4, 20], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: EASE_OUT,
          }),
        }}
      >
        chatgpt-oauth
      </div>
      <Typewriter
        chunks={[{ text: URL_TEXT }]}
        from={30}
        duration={62}
        fontSize={40}
        fontWeight={400}
        fontFamily={MONO}
      />
      <div
        style={{
          fontFamily: SANS,
          fontSize: 27,
          fontWeight: 400,
          color: DIM,
          opacity: interpolate(frame, [108, 124], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        MIT · experimental &amp; unofficial · users bring their own account
      </div>
    </AbsoluteFill>
  );
};

// ---------- root ----------

export const Promo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: WHITE }}>
      <Sequence name="Thesis" from={S.thesis.from} durationInFrames={S.thesis.len}>
        <ThesisScene />
      </Sequence>
      <Sequence name="Turn" from={S.turn.from} durationInFrames={S.turn.len}>
        <TurnScene />
      </Sequence>
      <Sequence name="Button" from={S.button.from} durationInFrames={S.button.len}>
        <ButtonScene />
      </Sequence>
      <Sequence name="Code" from={S.code.from} durationInFrames={S.code.len}>
        <CodeScene />
      </Sequence>
      <Sequence name="Languages" from={S.langs.from} durationInFrames={S.langs.len}>
        <LangsScene />
      </Sequence>
      <Sequence name="Stats" from={S.stats.from} durationInFrames={S.stats.len}>
        <StatsScene />
      </Sequence>
      <Sequence name="CTA" from={S.cta.from} durationInFrames={S.cta.len}>
        <CtaScene />
      </Sequence>

      {/* no music — the keys are the score. One real sample per typed character. */}
      <Sequence name="Keys: thesis" from={S.thesis.from} durationInFrames={S.thesis.len}>
        <KeyClicks text={THESIS_TEXT} from={26} duration={100} />
      </Sequence>
      <Sequence name="Keys: turn" from={S.turn.from} durationInFrames={S.turn.len}>
        <KeyClicks text={TURN_TEXT} from={8} duration={85} />
      </Sequence>
      <Sequence name="Keys: code A" from={S.code.from} durationInFrames={S.code.len}>
        <KeyClicks text={CODE_A} from={CODE_A_TYPE.from} duration={CODE_A_TYPE.duration} volume={0.42} />
      </Sequence>
      <Sequence name="Keys: code B" from={S.code.from} durationInFrames={S.code.len}>
        <KeyClicks text={CODE_B} from={CODE_B_TYPE.from} duration={CODE_B_TYPE.duration} volume={0.42} />
      </Sequence>
      <Sequence name="Keys: langs" from={S.langs.from} durationInFrames={S.langs.len}>
        <KeyClicks text={LANGS_TEXT} from={6} duration={80} />
      </Sequence>
      <Sequence name="Keys: url" from={S.cta.from} durationInFrames={S.cta.len}>
        <KeyClicks text={URL_TEXT} from={30} duration={62} />
      </Sequence>

      {/* accents */}
      <Sequence name="Button press key" from={S.button.from + 120} durationInFrames={20}>
        <Audio src={staticFile("sfx/key-heavy.wav")} volume={0.9} />
      </Sequence>
      <Sequence name="CTA return key" from={S.cta.from + 94} durationInFrames={20}>
        <Audio src={staticFile("sfx/key-heavy.wav")} volume={0.8} />
      </Sequence>
    </AbsoluteFill>
  );
};
