import { describe, expect, test } from 'bun:test';
import { WheelGesture } from './wheel-gesture';

const options = { linesPerStep: 3, maxMouseReports: 5, maxFallbackKeys: 1 };
const wheel = (deltaY: number, deltaMode = 1) => ({ deltaY, deltaMode });

describe('wheel gesture distance', () => {
  test('uses lines, cell-height pixels, and pages with fractional accumulation', () => {
    for (const [deltaMode, distance] of [
      [1, 3],
      [0, 60],
      [2, 1],
    ]) {
      const gesture = new WheelGesture();
      expect(gesture.consume(wheel(distance / 3, deltaMode), 20, 'mouse', options)).toBe(0);
      expect(gesture.consume(wheel(distance / 3, deltaMode), 20, 'mouse', options)).toBe(0);
      expect(gesture.consume(wheel(distance / 3, deltaMode), 20, 'mouse', options)).toBe(1);
    }
  });

  test('uses the 16-pixel metric fallback', () => {
    const gesture = new WheelGesture();
    expect(gesture.consume(wheel(47, 0), Number.NaN, 'mouse', options)).toBe(0);
    expect(gesture.consume(wheel(1, 0), 0, 'mouse', options)).toBe(1);
  });

  test('bounds each route and retains only fractional overflow', () => {
    const gesture = new WheelGesture();
    expect(gesture.consume(wheel(30.5), 20, 'mouse', options)).toBe(5);
    expect(gesture.consume(wheel(2.5), 20, 'mouse', options)).toBe(1);
    expect(gesture.consume(wheel(-300), 20, 'fallback', options)).toBe(-1);
    expect(gesture.consume(wheel(-1), 20, 'fallback', options)).toBe(0);
  });

  test('resets fractional distance on direction, route, and local ownership changes', () => {
    const gesture = new WheelGesture();
    expect(gesture.consume(wheel(2), 20, 'mouse', options)).toBe(0);
    expect(gesture.consume(wheel(-1), 20, 'mouse', options)).toBe(0);
    expect(gesture.consume(wheel(-2), 20, 'mouse', options)).toBe(-1);
    expect(gesture.consume(wheel(2), 20, 'mouse', options)).toBe(0);
    expect(gesture.consume(wheel(1), 20, 'fallback', options)).toBe(0);
    gesture.reset();
    expect(gesture.consume(wheel(2), 20, 'fallback', options)).toBe(0);
  });

  test('ignores invalid movement and bounds invalid host limits', () => {
    const gesture = new WheelGesture();
    expect(gesture.consume(wheel(Number.NaN), 20, 'mouse', options)).toBe(0);
    expect(gesture.consume(wheel(Infinity), 20, 'mouse', options)).toBe(0);
    expect(gesture.consume(wheel(0), 20, 'mouse', options)).toBe(0);
    expect(gesture.consume(wheel(1e6), 20, 'mouse', { maxMouseReports: Infinity })).toBe(1);
  });
});
