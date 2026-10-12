/**
 * Frame-accurate access to the source video for export: "give me the picture
 * at time t". Two implementations:
 *
 *  - DecodedVideo: demux the MP4/MOV (mp4box.js) and decode sequentially with
 *    WebCodecs VideoDecoder. Fast — each frame is decoded once.
 *  - SeekedVideo: an offscreen <video>, seeked once per output frame. Works for
 *    anything the browser can play, but each seek re-decodes from the previous
 *    keyframe, so it's several times slower. Used when the first one can't open.
 */
import { createFile, DataStream, MP4BoxBuffer } from 'mp4box';

/** A source picture plus the rotation needed to display it upright. */
export interface VideoPicture {
  image: CanvasImageSource;
  /** Coded size of `image` before rotation. */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface FrameSource {
  readonly method: 'decoder' | 'seek';
  frameAt(t: number): Promise<VideoPicture | null>;
  close(): void;
}

export async function openVideo(blob: Blob, startAt: number): Promise<FrameSource> {
  try {
    const dec = await DecodedVideo.open(blob, startAt);
    return dec;
  } catch (err) {
    console.warn('[export] sequential decode unavailable, seeking per frame instead:', err);
    return SeekedVideo.open(blob);
  }
}

// ---------------------------------------------------------------------------

interface Chunk {
  key: boolean;
  /** Presentation time in µs, on the same clock as <video>.currentTime. */
  ts: number;
  dur: number;
  offset: number;
  size: number;
}

class DecodedVideo implements FrameSource {
  readonly method = 'decoder' as const;
  private decoder: VideoDecoder;
  private frames: VideoFrame[] = [];
  private next = 0; // next chunk index (decode order) to feed
  private flushed = false;
  private error: Error | null = null;

  private constructor(
    private bytes: Uint8Array,
    private chunks: Chunk[],
    config: VideoDecoderConfig,
    private rotation: VideoPicture['rotation'],
  ) {
    this.decoder = new VideoDecoder({
      output: (f) => this.frames.push(f),
      error: (e) => (this.error = new Error(`video decoder: ${e.message}`)),
    });
    this.decoder.configure(config);
  }

  static async open(blob: Blob, startAt: number): Promise<DecodedVideo> {
    if (typeof VideoDecoder === 'undefined') throw new Error('no VideoDecoder');
    const buf = await blob.arrayBuffer();
    const file = createFile();
    let info: any = null;
    let parseError: unknown = null;
    file.onReady = (i: any) => (info = i);
    file.onError = (e: unknown) => (parseError = e);
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, 0), true);
    file.flush();
    if (parseError || !info) throw new Error(`not an MP4/MOV the demuxer understands (${parseError ?? 'no moov'})`);
    const track = info.videoTracks?.[0];
    if (!track) throw new Error('no video track');
    const trak: any = file.getTrackById(track.id);
    const samples: any[] = trak.samples ?? [];
    if (!samples.length) throw new Error('no video samples (fragmented file?)');

    let description: Uint8Array | undefined;
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, 1 /* big endian */);
        box.write(stream);
        description = new Uint8Array(stream.buffer as ArrayBuffer, 8); // drop the box header
        break;
      }
    }
    const config: VideoDecoderConfig = {
      codec: track.codec,
      codedWidth: track.video.width,
      codedHeight: track.video.height,
      ...(description ? { description } : {}),
    };
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error(`decoder doesn't support ${track.codec}`);

    // Edit list: map media time to presentation time the way <video> does.
    const ts: number = trak.mdia.mdhd.timescale;
    let shift = 0;
    const edits: any[] = trak.edts?.elst?.entries ?? [];
    for (const e of edits) {
      if (e.media_time === -1) shift += e.segment_duration / info.timescale; // leading gap
      else {
        shift -= e.media_time / ts;
        break;
      }
    }
    const chunks: Chunk[] = samples.map((s) => ({
      key: !!s.is_sync,
      ts: Math.round(((s.cts / ts) + shift) * 1e6),
      dur: Math.round((s.duration / ts) * 1e6),
      offset: s.offset,
      size: s.size,
    }));

    const m = track.matrix ?? trak.tkhd?.matrix;
    const rotation = matrixRotation(m);
    const dv = new DecodedVideo(new Uint8Array(buf), chunks, config, rotation);
    dv.seekStart(startAt);
    // Prove it works before committing to this path.
    const first = await dv.frameAt(startAt);
    if (!first) {
      dv.close();
      throw new Error('decoder produced no frames');
    }
    return dv;
  }

  /** Start feeding from the last keyframe at or before t. */
  private seekStart(t: number): void {
    const us = t * 1e6;
    let k = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].key && this.chunks[i].ts <= us) k = i;
      if (this.chunks[i].ts > us && this.chunks[i].key) break;
    }
    this.next = k;
  }

  async frameAt(t: number): Promise<VideoPicture | null> {
    const us = Math.round(t * 1e6) + 500; // half a ms of slack for rounding
    // Decode until we hold a frame that's later than t (or the stream ends).
    for (;;) {
      if (this.error) throw this.error;
      const last = this.frames[this.frames.length - 1];
      if (last && last.timestamp > us) break;
      if (this.next < this.chunks.length) {
        for (let n = 0; n < 6 && this.next < this.chunks.length; n++) {
          const c = this.chunks[this.next++];
          this.decoder.decode(
            new EncodedVideoChunk({
              type: c.key ? 'key' : 'delta',
              timestamp: c.ts,
              duration: c.dur,
              data: this.bytes.subarray(c.offset, c.offset + c.size),
            }),
          );
        }
        await new Promise((r) => setTimeout(r, 0));
        while (this.decoder.decodeQueueSize > 0 && !this.error) {
          await new Promise((r) => setTimeout(r, 0));
        }
      } else if (!this.flushed) {
        this.flushed = true;
        await this.decoder.flush();
      } else break;
    }
    // Keep only the newest frame at or before t (plus anything after it).
    while (this.frames.length > 1 && this.frames[1].timestamp <= us) this.frames.shift()!.close();
    const f = this.frames[0];
    if (!f) return null;
    return { image: f, width: f.displayWidth, height: f.displayHeight, rotation: this.rotation };
  }

  close(): void {
    for (const f of this.frames) f.close();
    this.frames = [];
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}

/** Rotation from a tkhd matrix (16.16 fixed point: [a, b, u, c, d, v, x, y, w]). */
function matrixRotation(m: ArrayLike<number> | undefined): VideoPicture['rotation'] {
  if (!m || m.length < 5) return 0;
  const a = m[0] | 0;
  const b = m[1] | 0;
  const deg = ((Math.round((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360;
  if (deg === 90 || deg === 180 || deg === 270) return deg;
  return 0;
}

// ---------------------------------------------------------------------------

class SeekedVideo implements FrameSource {
  readonly method = 'seek' as const;
  private el: HTMLVideoElement;
  private url: string;

  private constructor(blob: Blob) {
    this.url = URL.createObjectURL(blob);
    this.el = document.createElement('video');
    this.el.muted = true;
    this.el.playsInline = true;
    this.el.preload = 'auto';
    this.el.src = this.url;
  }

  static async open(blob: Blob): Promise<SeekedVideo> {
    const v = new SeekedVideo(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out loading the video')), 20000);
        v.el.onloadeddata = () => {
          clearTimeout(timer);
          resolve();
        };
        v.el.onerror = () => {
          clearTimeout(timer);
          reject(new Error('this browser cannot play the video'));
        };
      });
      if (!v.el.videoWidth) throw new Error('the video has no picture track');
    } catch (err) {
      v.close();
      throw err;
    }
    return v;
  }

  async frameAt(t: number): Promise<VideoPicture | null> {
    const el = this.el;
    const target = Math.min(Math.max(0, t), Math.max(0, el.duration - 0.001));
    if (Math.abs(el.currentTime - target) >= 0.0005) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 3000); // never hang on one bad seek
        function done() {
          clearTimeout(timer);
          el.removeEventListener('seeked', done);
          resolve();
        }
        el.addEventListener('seeked', done);
        el.currentTime = target;
      });
    }
    // <video> already applies the file's rotation when drawn.
    return { image: el, width: el.videoWidth, height: el.videoHeight, rotation: 0 };
  }

  close(): void {
    this.el.removeAttribute('src');
    this.el.load();
    URL.revokeObjectURL(this.url);
  }
}
