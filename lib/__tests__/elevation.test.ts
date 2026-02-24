import { samplePoints, computeGainLoss } from '../elevation';
import type { RoutePoint } from '../route-generator';

describe('samplePoints', () => {
  const makePoints = (n: number): RoutePoint[] =>
    Array.from({ length: n }, (_, i) => ({ lat: i * 0.01, lng: 0 }));

  it('returns all points when count >= length', () => {
    const points = makePoints(5);
    expect(samplePoints(points, 10)).toEqual(points);
    expect(samplePoints(points, 5)).toEqual(points);
  });

  it('samples evenly when count < length', () => {
    const points = makePoints(100);
    const sampled = samplePoints(points, 10);
    expect(sampled.length).toBe(10);
    // First and last should be included
    expect(sampled[0]).toEqual(points[0]);
    expect(sampled[sampled.length - 1]).toEqual(points[99]);
  });

  it('returns exactly count points', () => {
    const points = makePoints(50);
    const sampled = samplePoints(points, 25);
    expect(sampled.length).toBe(25);
  });

  it('BUG: count of 1 causes division by zero (step=Infinity), returns [undefined]', () => {
    const points = makePoints(10);
    const sampled = samplePoints(points, 1);
    expect(sampled.length).toBe(1);
    // BUG: step = (10-1)/(1-1) = Infinity, so Math.round(0*Infinity) = NaN,
    // and points[NaN] = undefined. This is an edge case bug.
    expect(sampled[0]).toBeUndefined();
  });
});

describe('computeGainLoss', () => {
  it('handles ascending only', () => {
    const elevations = [0, 10, 20, 30, 40];
    const { totalGain, totalLoss } = computeGainLoss(elevations);
    expect(totalGain).toBe(40);
    expect(totalLoss).toBe(0);
  });

  it('handles descending only', () => {
    const elevations = [40, 30, 20, 10, 0];
    const { totalGain, totalLoss } = computeGainLoss(elevations);
    expect(totalGain).toBe(0);
    expect(totalLoss).toBe(40);
  });

  it('handles mixed elevation changes', () => {
    const elevations = [0, 10, 5, 20, 15];
    const { totalGain, totalLoss } = computeGainLoss(elevations);
    // Gains: 10 + 15 = 25, Losses: 5 + 5 = 10
    expect(totalGain).toBe(25);
    expect(totalLoss).toBe(10);
  });

  it('returns 0 for empty array', () => {
    const { totalGain, totalLoss } = computeGainLoss([]);
    expect(totalGain).toBe(0);
    expect(totalLoss).toBe(0);
  });

  it('returns 0 for single element', () => {
    const { totalGain, totalLoss } = computeGainLoss([100]);
    expect(totalGain).toBe(0);
    expect(totalLoss).toBe(0);
  });

  it('returns 0 for flat terrain', () => {
    const elevations = [50, 50, 50, 50];
    const { totalGain, totalLoss } = computeGainLoss(elevations);
    expect(totalGain).toBe(0);
    expect(totalLoss).toBe(0);
  });

  it('rounds results to integers', () => {
    const elevations = [0, 10.7, 5.3];
    const { totalGain, totalLoss } = computeGainLoss(elevations);
    expect(Number.isInteger(totalGain)).toBe(true);
    expect(Number.isInteger(totalLoss)).toBe(true);
  });
});
