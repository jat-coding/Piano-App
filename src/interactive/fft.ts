/**
 * Magnitude spectrum of a block of samples, computed the way an AnalyserNode does it
 * (Blackman window, |X[k]| / size). The listener uses its own FFT so it can look at the
 * sound in fixed steps, whatever the screen's frame rate is.
 */
export class Spectrum {
  private win: Float64Array;
  private re: Float64Array;
  private im: Float64Array;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;

  constructor(readonly size: number) {
    const n = size;
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.win = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.win[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n);
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }

  /** `get(i)` = sample i of the block (0 = oldest). Writes size/2 magnitudes into `mag`. */
  compute(get: (i: number) => number, mag: Float32Array): void {
    const { size: n, re, im, rev, win } = this;
    for (let i = 0; i < n; i++) {
      re[rev[i]] = get(i) * win[i];
      im[rev[i]] = 0;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const p = i + k;
          const q = p + half;
          const vr = re[q] * wr - im[q] * wi;
          const vi = re[q] * wi + im[q] * wr;
          re[q] = re[p] - vr;
          im[q] = im[p] - vi;
          re[p] += vr;
          im[p] += vi;
        }
      }
    }
    const m = Math.min(mag.length, n / 2);
    for (let k = 0; k < m; k++) mag[k] = Math.hypot(re[k], im[k]) / n;
  }
}
