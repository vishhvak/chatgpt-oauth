import "./index.css";
import { Composition } from "remotion";
import { Promo } from "./promo/Promo";
import { Short } from "./promo/Short";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="short"
        component={Short}
        durationInFrames={195}
        fps={30}
        width={1080}
        height={1080}
      />
      <Composition
        id="promo"
        component={Promo}
        durationInFrames={1440}
        fps={30}
        width={1080}
        height={1080}
      />
    </>
  );
};
