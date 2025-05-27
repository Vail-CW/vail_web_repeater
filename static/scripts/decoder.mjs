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
    }

    reset() {
        this.currentMorsePattern = '';
        this.decodedText = ''; // Not strictly used by the decoder itself but can be for debugging
    }

    // Call this when a signal starts (key down)
    signalStart(timestamp) {
        if (this.lastSignalTime === 0) { // First signal
            this.lastSignalTime = timestamp;
            return;
        }

        const offDuration = timestamp - this.lastSignalTime;
        this.lastSignalTime = timestamp;
        this.lastOffTime = offDuration;

        this.processSilence(offDuration);
    }

    // Call this when a signal ends (key up)
    signalEnd(timestamp) {
        if (this.lastSignalTime === 0) return;

        const onDuration = timestamp - this.lastSignalTime;
        this.lastSignalTime = timestamp;

        // Define a minimum duration for a signal to be considered a mark.
        // This can be absolute (e.g., 15-20ms) or relative to unitTime,
        // but an absolute minimum helps against noise when unitTime is still unstable.
        const MIN_MARK_DURATION = 15; // milliseconds

        if (onDuration < MIN_MARK_DURATION) {
            // console.log(`Ignoring very short signal: ${onDuration}ms`); // Optional debug
            return; // Ignore very short signals / noise
        }

        // Add to signal buffer and maintain its size
        this.signalBuffer.push(onDuration);
        if (this.signalBuffer.length > this.MAX_SIGNAL_HISTORY) {
            this.signalBuffer.shift();
        }
        this.updateUnitTime(); // updateUnitTime might also benefit from only using valid marks

        if (onDuration < this.unitTime * this.DIT_DAH_RATIO_THRESHOLD) {
            this.currentMorsePattern += '.';
        } else {
            this.currentMorsePattern += '-';
        }
    }

    processSilence(duration) {
        if (this.currentMorsePattern === '') return; // Nothing to process yet

        if (duration > this.unitTime * this.MEDIUM_SPACE_RATIO) { // Word space
            this.decodeCurrentPattern();
            this.onDecodedChar(' '); // Add word space
            this.currentMorsePattern = '';
        } else if (duration > this.unitTime * this.SHORT_SPACE_RATIO) { // Character space
            this.decodeCurrentPattern();
            this.currentMorsePattern = '';
        } else if (duration > this.unitTime * this.INTER_ELEMENT_SPACE_RATIO) {
            // Inter-element space, do nothing, wait for next signal
        }
        // Shorter silences are part of the current character, also do nothing.
    }

    decodeCurrentPattern() {
        if (this.currentMorsePattern && this.MORSE_CODE_LOOKUP[this.currentMorsePattern]) {
            const char = this.MORSE_CODE_LOOKUP[this.currentMorsePattern];
            this.onDecodedChar(char);
            this.decodedText += char; // For internal tracking/debugging
        }
        // Optionally handle unknown patterns, e.g., this.onDecodedChar('?')
        this.currentMorsePattern = '';
    }

    // Dynamically updates the unitTime (dit duration)
    updateUnitTime() {
        if (this.signalBuffer.length === 0) return;

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
        }
        // console.log("Updated unit time:", this.unitTime); // For debugging
    }

    // Call this if there's a long pause or a timeout to force decoding of the last pattern
    forceDecode() {
        this.processSilence(this.unitTime * (this.MEDIUM_SPACE_RATIO + 1)); // Simulate a long space
    }
}
