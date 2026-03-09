export type UnitSystem = 'imperial' | 'metric';

const KM_PER_MI = 1.60934;
const FT_PER_M = 3.28084;

export function formatDistance(km: number, units: UnitSystem): string {
  if (units === 'imperial') {
    return (km / KM_PER_MI).toFixed(1);
  }
  return km.toFixed(1);
}

export function formatPace(minPerKm: string, units: UnitSystem): string {
  if (units === 'imperial') {
    const val = parseFloat(minPerKm);
    if (isNaN(val)) return minPerKm;
    return (val * KM_PER_MI).toFixed(1);
  }
  return minPerKm;
}

export function formatElevation(meters: number, units: UnitSystem): string {
  if (units === 'imperial') {
    return String(Math.round(meters * FT_PER_M));
  }
  return String(Math.round(meters));
}

export function distanceUnit(units: UnitSystem): string {
  return units === 'imperial' ? 'mi' : 'km';
}

export function paceUnit(units: UnitSystem): string {
  return units === 'imperial' ? '/mi' : '/km';
}

export function elevationUnit(units: UnitSystem): string {
  return units === 'imperial' ? 'ft' : 'm';
}

export function milesToKm(miles: number): number {
  return miles * KM_PER_MI;
}

export function kmToMiles(km: number): number {
  return km / KM_PER_MI;
}
