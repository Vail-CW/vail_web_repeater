// Basic Morse code lookup table
const MORSE_CODE_LOOKUP = {
    '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E',
    '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
    '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O',
    '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
    '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y',
    '--..': 'Z',
    '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4',
    '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
    '.-.-.-': '.', '--..--': ',', '..--..': '?', '.----.': "'",
    '-.-.--': '!', '-..-.': '/', '-.--.': '(', '-.--.-': ')',
    '.-...': '&', '---...': ':', '-.-.-.': ';', '-...-': '=',
    '.-.-.': '+', '-....-': '-', '..--.-': '_', '.-..-.': '"',
    '...-..-': '$', '.--.-.': '@',
    // Special characters (prosigns)
    '...-.': 'SK', // End of work
    '-.-.-': 'CT', // Starting signal (KA)
    '...-.-': 'AS', // Wait
    '.-.-': 'AR', // End of message / New page
    '-...-': 'BT', // Pause / Separator (double dash)
};

const MAX_SIGNAL_HISTORY = 20; // Number of recent signal durations to keep for dynamic speed adjustment
const DIT_DAH_RATIO_THRESHOLD = 2; // If dah is DIT_DAH_RATIO_THRESHOLD times longer than dit, it's a dah
const INTER_ELEMENT_SPACE_RATIO = 0.7; // Max space within a character (relative to unit time)
const SHORT_SPACE_RATIO = 2.0; // Max space between characters (relative to unit time)
const MEDIUM_SPACE_RATIO = 5.0; // Max space between words (relative to unit time)

export class MorseDecoder {
    constructor(onDecodedChar) {
        this.onDecodedChar = onDecodedChar; // Callback function when a character is decoded

        // Assign constants as instance properties
        this.MAX_SIGNAL_HISTORY = 20;
        this.DIT_DAH_RATIO_THRESHOLD = 2;
        this.INTER_ELEMENT_SPACE_RATIO = 0.7;
        this.SHORT_SPACE_RATIO = 2.0;
        this.MEDIUM_SPACE_RATIO = 5.0;
        this.MORSE_CODE_LOOKUP = MORSE_CODE_LOOKUP;

        this.reset();
        this.signalBuffer = []; // Stores recent signal (on-time) durations
        this.lastOffTime = 0; // Duration of the last off-period (silence)
        this.unitTime = 100; // ms - initial guess for a dit duration, will be dynamically adjusted
        this.lastSignalTime = 0; // Timestamp of the last signal edge (on or off)
        this.id = Math.random().toString(36).substring(2, 7); // Simple ID for multiple decoders if ever
        console.log(`[Decoder ${this.id}] Initialized. unitTime: ${this.unitTime}`);
    }

    reset() {
        console.log(`[Decoder ${this.id}] Resetting. Old pattern: '${this.currentMorsePattern}'`);
        this.currentMorsePattern = '';
        this.decodedText = ''; // Not strictly used by the decoder itself but can be for debugging
    }

    // Call this when a signal starts (key down)
    signalStart(timestamp) {
        console.log(`[Decoder ${this.id}] signalStart called at ${timestamp}. Last signal time: ${this.lastSignalTime}`);
        if (this.lastSignalTime === 0) { // First signal
            this.lastSignalTime = timestamp;
            console.log(`[Decoder ${this.id}] First signal, only updating lastSignalTime to ${timestamp}.`);
            return;
        }

        const offDuration = timestamp - this.lastSignalTime;
        console.log(`[Decoder ${this.id}] Calculated offDuration (silence): ${offDuration}ms.`);
        this.lastSignalTime = timestamp;
        this.lastOffTime = offDuration;

        this.processSilence(offDuration);
    }

    // Call this when a signal ends (key up)
    signalEnd(timestamp) {
        console.log(`[Decoder ${this.id}] signalEnd called at ${timestamp}. Last signal time: ${this.lastSignalTime}`);
        if (this.lastSignalTime === 0) {
             console.warn(`[Decoder ${this.id}] signalEnd called without prior signalStart or with reset lastSignalTime.`);
             this.lastSignalTime = timestamp - this.unitTime; // Try to recover reasonably
        }

        const onDuration = timestamp - this.lastSignalTime;
        this.lastSignalTime = timestamp;

        // Define a minimum duration for a signal to be considered a mark.
        // This can be absolute (e.g., 15-20ms) or relative to unitTime,
        // but an absolute minimum helps against noise when unitTime is still unstable.
        const MIN_MARK_DURATION = 15; // milliseconds
        console.log(`[Decoder ${this.id}] Calculated onDuration (mark): ${onDuration}ms. MIN_MARK_DURATION: ${MIN_MARK_DURATION}ms.`);

        if (onDuration < MIN_MARK_DURATION) {
            console.log(`[Decoder ${this.id}] Ignoring very short signal: ${onDuration}ms.`);
            return; // Ignore very short signals / noise
        }

        // Add to signal buffer and maintain its size
        this.signalBuffer.push(onDuration);
        if (this.signalBuffer.length > this.MAX_SIGNAL_HISTORY) {
            this.signalBuffer.shift();
        }
        this.updateUnitTime(); // updateUnitTime might also benefit from only using valid marks

        let mark = '';
        if (onDuration < this.unitTime * this.DIT_DAH_RATIO_THRESHOLD) {
            this.currentMorsePattern += '.';
            mark = '.';
        } else {
            this.currentMorsePattern += '-';
            mark = '-';
        }
        console.log(`[Decoder ${this.id}] Appended '${mark}' to pattern. New pattern: '${this.currentMorsePattern}'. unitTime: ${this.unitTime.toFixed(2)}ms.`);
    }

    processSilence(duration) {
        console.log(`[Decoder ${this.id}] processSilence called with duration: ${duration.toFixed(2)}ms. Current pattern: '${this.currentMorsePattern}'. unitTime: ${this.unitTime.toFixed(2)}ms.`);
        if (this.currentMorsePattern === '') {
            console.log(`[Decoder ${this.id}] No current pattern to process with this silence.`);
            return;
        }

        if (duration > this.unitTime * this.MEDIUM_SPACE_RATIO) { // Word space
            console.log(`[Decoder ${this.id}] Interpreted as WORD_SPACE (>${(this.unitTime * this.MEDIUM_SPACE_RATIO).toFixed(2)}ms).`);
            this.decodeCurrentPattern();
            this.onDecodedChar(' '); // Add word space
            this.currentMorsePattern = ''; // Already done in decodeCurrentPattern, but for clarity
        } else if (duration > this.unitTime * this.SHORT_SPACE_RATIO) { // Character space
            console.log(`[Decoder ${this.id}] Interpreted as CHARACTER_SPACE (>${(this.unitTime * this.SHORT_SPACE_RATIO).toFixed(2)}ms).`);
            this.decodeCurrentPattern();
        } else if (duration > this.unitTime * this.INTER_ELEMENT_SPACE_RATIO) {
            console.log(`[Decoder ${this.id}] Interpreted as INTER_ELEMENT_SPACE (>${(this.unitTime * this.INTER_ELEMENT_SPACE_RATIO).toFixed(2)}ms). Pattern preserved.`);
            // Inter-element space, do nothing, wait for next signal
        } else {
            console.log(`[Decoder ${this.id}] Silence too short (${duration.toFixed(2)}ms), considered part of current pattern or noise.`);
        }
    }

    decodeCurrentPattern() {
        console.log(`[Decoder ${this.id}] decodeCurrentPattern called. Pattern: '${this.currentMorsePattern}'.`);
        if (this.currentMorsePattern && this.MORSE_CODE_LOOKUP[this.currentMorsePattern]) {
            const char = this.MORSE_CODE_LOOKUP[this.currentMorsePattern];
            console.log(`[Decoder ${this.id}] Decoded pattern '${this.currentMorsePattern}' to '${char}'.`);
            this.onDecodedChar(char);
            this.decodedText += char; // For internal tracking/debugging
        } else if (this.currentMorsePattern) {
            console.log(`[Decoder ${this.id}] Pattern '${this.currentMorsePattern}' not found in MORSE_CODE_LOOKUP.`);
            // Optionally: this.onDecodedChar('?');
        }
        this.currentMorsePattern = ''; // Always reset pattern after attempting decode
    }

    // Dynamically updates the unitTime (dit duration)
    updateUnitTime() {
        const oldUnitTime = this.unitTime;
        if (this.signalBuffer.length === 0) {
            console.log(`[Decoder ${this.id}] updateUnitTime: Signal buffer empty. unitTime remains ${this.unitTime.toFixed(2)}ms.`);
            return;
        }

        // Simple approach: use the shortest signal in the buffer as a candidate for unitTime
        // More sophisticated methods could involve clustering or averaging.
        let sortedSignals = [...this.signalBuffer].sort((a, b) => a - b);
        
        // Filter out overly long signals that are definitely dahs or noise
        const potentialDits = sortedSignals.filter(s => s < ( (sortedSignals[Math.floor(sortedSignals.length / 2)] || this.unitTime * 1.5) * this.DIT_DAH_RATIO_THRESHOLD));

        if (potentialDits.length > 0) {
            // Average of the shortest third of signals, or just the shortest if few signals
            const numToAverage = Math.max(1, Math.floor(potentialDits.length / 3));
            const sum = potentialDits.slice(0, numToAverage).reduce((acc, val) => acc + val, 0);
            this.unitTime = Math.max(20, sum / numToAverage); // Ensure unitTime is not too small (e.g. 20ms min)
            console.log(`[Decoder ${this.id}] updateUnitTime: Buffer: [${this.signalBuffer.join(', ')}]. Potential dits: [${potentialDits.join(', ')}]. New unitTime: ${this.unitTime.toFixed(2)}ms (was ${oldUnitTime.toFixed(2)}ms).`);
        } else if (this.signalBuffer.length > 0) {
            // If no potential dits found but buffer has signals (likely all long signals)
            // Avoid changing unitTime drastically, or reset to a default if it's too far off.
            // For now, just log. This case might need more thought if it causes issues.
            console.log(`[Decoder ${this.id}] updateUnitTime: Buffer: [${this.signalBuffer.join(', ')}]. No potential dits found. unitTime remains ${this.unitTime.toFixed(2)}ms.`);
        }
        // The 'else' for signalBuffer empty is now at the top of the function.
    }

    // Call this if there's a long pause or a timeout to force decoding of the last pattern
    forceDecode() {
        console.log(`[Decoder ${this.id}] forceDecode called. Current pattern: '${this.currentMorsePattern}'. Simulating long silence.`);
        this.processSilence(this.unitTime * (this.MEDIUM_SPACE_RATIO + 1)); // Simulate a long space
    }
}
