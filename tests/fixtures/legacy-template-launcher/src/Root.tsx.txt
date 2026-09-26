import "./index.css";
import { Composition } from "remotion";
import { MainVideo } from "./MainVideo";
import { FPS, DURATION_FRAMES, RESOLUTION } from "./videoConfig";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MainVideo"
        component={MainVideo}
        durationInFrames={DURATION_FRAMES}
        fps={FPS}
        width={RESOLUTION.width}
        height={RESOLUTION.height}
      />
    </>
  );
};
