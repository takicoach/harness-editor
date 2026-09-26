/**
 * The sound palette — layer/recipe types plus the ten built-in recipes.
 * Each sound has its own distinct shape — a chime, an arpeggio, a pitch
 * glide, a warm pad, a breath — rather than being a volume/EQ tweak on
 * the same click. Add a new one here without touching any audio graph code.
 */
export const RECIPES = {
    /** A soft two-note ascending bell, like an iOS/macOS confirmation tink. */
    chime: {
        masterGain: 0.5,
        layers: [
            { kind: "tone", waveform: "sine", frequency: 1046.5, attack: 0.006, decay: 0.22, peak: 0.09 },
            { kind: "tone", waveform: "sine", frequency: 1568, offset: 0.09, attack: 0.006, decay: 0.26, peak: 0.08 },
        ],
        shimmer: { delay: 0.12, feedback: 0.25, wet: 0.18, lowpass: 4000 },
    },
    /** A quick ascending twinkle of four notes — bright and playful. */
    sparkle: {
        masterGain: 0.5,
        layers: [
            { kind: "tone", waveform: "sine", frequency: 1760, offset: 0, attack: 0.003, decay: 0.09, peak: 0.045 },
            { kind: "tone", waveform: "sine", frequency: 2217, offset: 0.045, attack: 0.003, decay: 0.09, peak: 0.04 },
            { kind: "tone", waveform: "sine", frequency: 2637, offset: 0.09, attack: 0.003, decay: 0.1, peak: 0.038 },
            { kind: "tone", waveform: "sine", frequency: 3520, offset: 0.135, attack: 0.003, decay: 0.12, peak: 0.032 },
        ],
        shimmer: { delay: 0.07, feedback: 0.35, wet: 0.22, lowpass: 6000 },
    },
    /** A single note gliding smoothly downward, like a drop of water. */
    droplet: {
        masterGain: 0.55,
        layers: [
            { kind: "tone", waveform: "sine", frequency: 1200, glideTo: 550, glideTime: 0.14, attack: 0.004, decay: 0.2, peak: 0.075 },
        ],
        shimmer: { delay: 0.09, feedback: 0.2, wet: 0.15, lowpass: 3000 },
    },
    /** A warm, slow-swelling pad from two gently detuned sines. */
    bloom: {
        masterGain: 0.5,
        layers: [
            { kind: "tone", waveform: "sine", frequency: 528, attack: 0.06, decay: 0.32, peak: 0.06 },
            { kind: "tone", waveform: "sine", frequency: 528, detune: 12, attack: 0.06, decay: 0.34, peak: 0.05 },
        ],
        shimmer: { delay: 0.15, feedback: 0.2, wet: 0.12, lowpass: 2500 },
    },
    /** The quietest option — a breathy, textureless swell for dense lists. */
    whisper: {
        masterGain: 0.5,
        layers: [
            { kind: "noise", filterType: "lowpass", filterFrequency: 1200, filterQ: 0.7, attack: 0.04, decay: 0.16, peak: 0.05 },
        ],
    },
    /** A focused, bandpass-filtered tick with a bright sine ping on top — crisp and instant. */
    tick: {
        masterGain: 0.4,
        layers: [
            { kind: "noise", filterType: "bandpass", filterFrequency: 5400, filterQ: 1.8, attack: 0.001, decay: 0.018, peak: 0.14 },
            { kind: "tone", waveform: "sine", frequency: 2600, attack: 0.001, decay: 0.012, peak: 0.018 },
        ],
    },
    /** A dull, muted knock — the "down" half of a press/release pair, like a key bottoming out. */
    press: {
        masterGain: 0.4,
        layers: [
            { kind: "noise", filterType: "bandpass", filterFrequency: 1700, filterQ: 1.4, attack: 0.001, decay: 0.02, peak: 0.13 },
        ],
    },
    /** A brighter, springier tick — the "up" half of a press/release pair, like a key returning. */
    release: {
        masterGain: 0.4,
        layers: [
            { kind: "noise", filterType: "bandpass", filterFrequency: 4600, filterQ: 1.8, attack: 0.001, decay: 0.016, peak: 0.12 },
            { kind: "tone", waveform: "sine", frequency: 3200, offset: 0.006, attack: 0.001, decay: 0.05, peak: 0.02 },
        ],
    },
    /** A two-part click-clack, like a mechanical switch flipping between states. */
    toggle: {
        masterGain: 0.4,
        layers: [
            { kind: "noise", filterType: "bandpass", filterFrequency: 2200, filterQ: 1.6, attack: 0.001, decay: 0.016, peak: 0.12 },
            { kind: "noise", filterType: "bandpass", filterFrequency: 3800, filterQ: 1.6, offset: 0.024, attack: 0.001, decay: 0.02, peak: 0.1 },
        ],
    },
    /** A short, warm three-note ascending confirmation — "done", not a fanfare. */
    success: {
        masterGain: 0.5,
        layers: [
            { kind: "tone", waveform: "sine", frequency: 880, attack: 0.004, decay: 0.09, peak: 0.06 },
            { kind: "tone", waveform: "sine", frequency: 1108.73, offset: 0.06, attack: 0.004, decay: 0.1, peak: 0.06 },
            { kind: "tone", waveform: "sine", frequency: 1318.51, offset: 0.12, attack: 0.004, decay: 0.18, peak: 0.07 },
        ],
        shimmer: { delay: 0.1, feedback: 0.22, wet: 0.16, lowpass: 4500 },
    },
};
export function isSoundName(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(RECIPES, value);
}
/** All available sound names, derived from the recipe palette. */
export const sounds = Object.keys(RECIPES);
