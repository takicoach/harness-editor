import { Audio, staticFile } from 'remotion';

interface BGMProps {
  volume?: number;
}

const BGM_FILE = 'BGM/bgm.mp3';

export const BGM: React.FC<BGMProps> = ({ volume = 0.3 }) => {
  return (
    <Audio
      src={staticFile(BGM_FILE)}
      volume={volume}
      loop
    />
  );
};
