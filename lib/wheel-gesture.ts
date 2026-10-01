/** Compatibility controls for engine-owned wheel input, independent of host policy. */
export interface WheelScrollOptions {
  linesPerStep?: number;
  maxMouseReports?: number;
  maxFallbackKeys?: number;
  alternateScreenFallback?: 'arrows' | 'page';
  mouseEncoding?: 'auto' | 'sgr';
}

export class WheelGesture {
  private route: 'mouse' | 'fallback' | undefined;
  private remainder = 0;

  reset(): void {
    this.route = undefined;
    this.remainder = 0;
  }

  consume(
    event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
    cellHeight: number,
    route: 'mouse' | 'fallback',
    options: WheelScrollOptions = {}
  ): number {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return 0;
    if (route !== this.route) {
      this.reset();
      this.route = route;
    }
    const linesPerStep = positiveNumber(options.linesPerStep, 3);
    const height = positiveNumber(cellHeight, 16);
    const delta =
      event.deltaMode === 2
        ? event.deltaY
        : event.deltaY / (event.deltaMode === 1 ? linesPerStep : height * linesPerStep);
    if (!Number.isFinite(delta)) return 0;
    if (this.remainder !== 0 && Math.sign(this.remainder) !== Math.sign(delta)) {
      this.remainder = 0;
    }
    const total = this.remainder + delta;
    const epsilon = Number.EPSILON * 8;
    const whole = Math.trunc(total + Math.sign(total) * epsilon);
    this.remainder = total - whole;
    if (Math.abs(this.remainder) < epsilon) this.remainder = 0;
    if (whole === 0) return 0;
    const limit = Math.max(
      1,
      Math.min(
        100,
        Math.trunc(
          positiveNumber(
            route === 'mouse' ? options.maxMouseReports : options.maxFallbackKeys,
            route === 'mouse' ? 1 : 5
          )
        )
      )
    );
    return Math.max(-limit, Math.min(whole, limit));
  }
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
