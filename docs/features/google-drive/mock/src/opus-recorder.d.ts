// The part of opus-recorder (no bundled types) that lib/voice-recorder.ts uses.
declare module 'opus-recorder' {
  interface RecorderConfig {
    sourceNode?: MediaStreamAudioSourceNode;
    encoderPath?: string;
    encoderApplication?: 2048 | 2049 | 2051;
    encoderSampleRate?: 8000 | 12000 | 16000 | 24000 | 48000;
    numberOfChannels?: number;
    streamPages?: boolean;
  }
  export default class Recorder {
    constructor(config?: RecorderConfig);
    ondataavailable: (bytes: Uint8Array<ArrayBuffer>) => void;
    start(): Promise<void>;
    stop(): Promise<void> | void;
    static isRecordingSupported(): boolean;
  }
}
