import log from 'loglevel';
import { ParticipantInfo, TrackType } from '../../proto/model';
import { ParticipantEvent, TrackEvent } from '../events';
import { RemoteAudioTrack } from '../track/RemoteAudioTrack';
import { RemoteAudioTrackPublication } from '../track/RemoteAudioTrackPublication';
import { RemoteDataTrack } from '../track/RemoteDataTrack';
import { RemoteDataTrackPublication } from '../track/RemoteDataTrackPublication';
import { RemoteTrackPublication } from '../track/RemoteTrackPublication';
import { RemoteVideoTrack } from '../track/RemoteVideoTrack';
import { RemoteVideoTrackPublication } from '../track/RemoteVideoTrackPublication';
import { Track } from '../track/Track';
import {
  createRemoteTrackPublicationFromInfo,
  RemoteTrack,
} from '../track/types';
import { Participant } from './Participant';

export class RemoteParticipant extends Participant {
  private participantInfo?: ParticipantInfo;
  audioTracks: Map<string, RemoteAudioTrackPublication>;
  videoTracks: Map<string, RemoteVideoTrackPublication>;
  dataTracks: Map<string, RemoteDataTrackPublication>;
  tracks: Map<string, RemoteTrackPublication>;

  /** @internal */
  static fromParticipantInfo(pi: ParticipantInfo): RemoteParticipant {
    const rp = new RemoteParticipant(pi.sid, pi.identity);
    rp.updateInfo(pi);
    return rp;
  }

  /** @internal */
  constructor(id: string, name?: string) {
    super(id, name || '');
    this.tracks = new Map();
    this.audioTracks = new Map();
    this.videoTracks = new Map();
    this.dataTracks = new Map();
  }

  /** @internal */
  addSubscribedMediaTrack(
    mediaTrack: MediaStreamTrack,
    sid: Track.SID,
    triesLeft?: number
  ) {
    // find the track publication
    // it's possible for the media track to arrive before participant info
    let publication = this.getTrackPublication(sid);

    // it's also possible that the browser didn't honor our original track id
    // FireFox would use its own local uuid instead of server track id
    if (!publication) {
      if (!sid.startsWith('TR')) {
        // find the first track that matches type
        this.tracks.forEach((p) => {
          if (!publication && mediaTrack.kind === p.kind.toString()) {
            publication = p;
          }
        });
      }
    }

    // when we couldn't locate the track, it's possible that the metadata hasn't
    // yet arrived. Wait a bit longer for it to arrive, or fire an error
    if (!publication) {
      if (triesLeft === 0) {
        log.error('could not find published track', this.sid, sid);
        this.emit(ParticipantEvent.TrackSubscriptionFailed, sid);
        return;
      }

      if (triesLeft === undefined) triesLeft = 20;
      setTimeout(() => {
        this.addSubscribedMediaTrack(mediaTrack, sid, triesLeft! - 1);
      }, 150);
      return;
    }

    const isVideo = mediaTrack.kind === 'video';
    let track: RemoteTrack;
    if (isVideo) {
      track = new RemoteVideoTrack(mediaTrack, sid);
    } else {
      track = new RemoteAudioTrack(mediaTrack, sid);
    }

    publication.track = track;
    // set track name etc
    track.name = publication.trackName;
    track.sid = publication.trackSid;

    // when media track is ended, fire the event
    mediaTrack.onended = (ev) => {
      this.emit(ParticipantEvent.TrackUnsubscribed, track, publication);
    };
    this.emit(ParticipantEvent.TrackSubscribed, track, publication);

    return publication;
  }

  /** @internal */
  addSubscribedDataTrack(
    dataChannel: RTCDataChannel,
    sid: Track.SID,
    name: string
  ): RemoteTrackPublication {
    const track = new RemoteDataTrack(sid, name, dataChannel);
    let publication = this.getTrackPublication(sid);

    if (!publication) {
      publication = new RemoteDataTrackPublication(
        {
          sid: sid,
          name: name,
          type: TrackType.DATA,
          muted: false,
        },
        track
      );
      this.addTrackPublication(publication);

      // only send this after metadata is filled in, which indicates the track
      // is published AFTER client connected to room
      if (this.hasMetadata) {
        this.emit(ParticipantEvent.TrackPublished, publication);
      }
    } else {
      publication.track = track;
    }

    track.on(TrackEvent.Message, (data: any) => {
      // forward this
      this.emit(ParticipantEvent.TrackMessage, data, track);
    });

    dataChannel.onclose = (ev) => {
      this.emit(ParticipantEvent.TrackUnsubscribed, track, publication);
    };
    this.emit(ParticipantEvent.TrackSubscribed, track, publication);

    return publication;
  }

  /** @internal */
  get hasMetadata(): boolean {
    return !!this.participantInfo;
  }

  getTrackPublication(sid: Track.SID): RemoteTrackPublication | undefined {
    return this.tracks.get(sid);
  }

  /** @internal */
  updateInfo(info: ParticipantInfo) {
    const alreadyHasMetadata = this.hasMetadata;

    this.identity = info.identity;
    this.sid = info.sid;
    this.participantInfo = info;
    this.setMetadata(info.metadata);

    // we are getting a list of all available tracks, reconcile in here
    // and send out events for changes

    // reconcile track publications, publish events only if metadata is already there
    // i.e. changes since the local participant has joined
    const validTracks = new Map<string, RemoteTrackPublication>();
    const newTracks = new Map<string, RemoteTrackPublication>();

    info.tracks.forEach((ti) => {
      let publication = this.getTrackPublication(ti.sid);
      if (!publication) {
        // new publication
        publication = createRemoteTrackPublicationFromInfo(ti);
        newTracks.set(ti.sid, publication);
        this.addTrackPublication(publication);
      } else {
        publication.updateMetadata(ti);
      }
      validTracks.set(ti.sid, publication);
    });

    // send new tracks
    if (alreadyHasMetadata) {
      newTracks.forEach((publication) => {
        this.emit(ParticipantEvent.TrackPublished, publication);
      });
    }

    // detect removed tracks
    this.tracks.forEach((publication) => {
      if (!validTracks.has(publication.trackSid)) {
        this.unpublishTrack(publication.trackSid, true);
      }
    });
  }

  /** @internal */
  unpublishTrack(sid: Track.SID, sendUnpublish?: boolean) {
    const publication = <RemoteTrackPublication>this.tracks.get(sid);
    if (!publication) {
      return;
    }

    this.tracks.delete(sid);

    // remove from the right type map
    switch (publication.kind) {
      case Track.Kind.Audio:
        this.audioTracks.delete(sid);
        break;
      case Track.Kind.Video:
        this.videoTracks.delete(sid);
        break;
      case Track.Kind.Data:
        this.dataTracks.delete(sid);
        break;
    }

    // also send unsubscribe, if track is actively subscribed
    if (publication.track) {
      publication.track.stop();
      publication.track = undefined;
      // always send unsubscribed, since apps may rely on this
      this.emit(ParticipantEvent.TrackUnsubscribed, publication);
    }
    if (sendUnpublish)
      this.emit(ParticipantEvent.TrackUnpublished, publication);
  }

  /** @internal */
  emit(event: string | symbol, ...args: any[]): boolean {
    log.trace('participant event', this.sid, event, ...args);
    return super.emit(event, ...args);
  }
}