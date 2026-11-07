// Tonight's moon, rendered from NASA's LRO color and elevation maps (CGI Moon Kit, svs.gsfc.nasa.gov/4720, public domain).
// The 30 frames live once, as drawables in the native module (res/drawable-nodpi/moon_NN.jpg), so the lock
// screen can show them too. Frame k shows the moon k days after new moon; Overlay.kt and the Mac do the same sum.
const SYNODIC = 29.530588853; // days from new moon to new moon
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // a known new moon to count from

export function moon(at = Date.now()) {
  const age = ((((at - NEW_MOON) / 86_400_000) % SYNODIC) + SYNODIC) % SYNODIC;
  const lit = Math.round(((1 - Math.cos((2 * Math.PI * age) / SYNODIC)) / 2) * 100);
  const name = age < 1.85 || age >= 27.68 ? "New moon" : age < 5.54 ? "Waxing crescent" : age < 9.23 ? "First quarter"
    : age < 12.92 ? "Waxing gibbous" : age < 16.61 ? "Full moon" : age < 20.3 ? "Waning gibbous" : age < 23.99 ? "Last quarter" : "Waning crescent";
  return { image: { uri: `moon_${String(Math.min(29, Math.floor(age))).padStart(2, "0")}` }, name, lit, age };
}
