import { VideoCodec, VideoEncoding } from '../../options';

/**
 * Options when publishing tracks
 */
export interface TrackPublishOptions {
  /**
   * set a track name
   */
  name?: string;

  /**
   * encoding parameters, if empty, LiveKit will automatically select an appropriate
   * encoding based on bitrate
   */
  videoEncoding?: VideoEncoding;

  /**
   * codec, defaults to vp8
   */
  videoCodec?: VideoCodec;

  /**
   * use simulcast, defaults to false.
   * When using simulcast, LiveKit will publish up to three version of the stream at varying qualiti
   */
  simulcast?: boolean;
}

/**
 * Options when publishing data tracks
 */
export interface LocalDataTrackOptions {
  name?: string;
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
  ordered?: boolean;
}