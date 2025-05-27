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
        this.MIN_SIGNALS_FOR_UNIT_TIME_UPDATE = 5;
        console.log(`[Decoder ${this.id}] Initialized. unitTime: ${this.unitTime}`);
    }

    reset() {
        console.log(`[Decoder ${this.id}] Resetting. Old pattern: '${this.currentMorsePattern}'`);
        this.currentMorsePattern = '';
        this.decodedText = ''; // Not strictly used by the decoder itself but can be for debugging
    }

    // Call this when a signal starts (key down)
    signalStart(timestamp) {
        console.log(`[Decoder ${this.id}] signalStart called at ${timestamp}. Current internal lastSignalTime: ${this.lastSignalTime}`);

        if (this.lastSignalTime === 0) { // First signal ever for this decoder instance
            // For the very first signal, there's no preceding silence to process.
            // We don't set this.lastSignalTime here; signalEnd will set it after the first mark.
            // Or, if this first event is a long silence from the start, processSilence might handle it.
            // Let's assume an initial this.lastSignalTime of 0 means "beginning of time" for silence calculation.
            // A very large offDuration will be treated as a word space.
            console.log(`[Decoder ${this.id}] First signal event.`);
        }

        const offDuration = timestamp - this.lastSignalTime;
        console.log(`[Decoder ${this.id}] Calculated offDuration (silence): ${offDuration}ms.`);

        // Process the calculated silence.
        // processSilence might update this.lastSignalTime if it decodes a character/word.
        this.processSilence(offDuration);
        
        // CRUCIAL CHANGE: Do NOT update this.lastSignalTime = timestamp here.
        // this.lastSignalTime should only be updated:
        //   1. By signalEnd, to the END of a mark.
        //   2. By processSilence, to the END of a recognized character/word space (implicitly, via currentMorsePattern reset and next signal's silence calc).
        // For the current mark that this signalStart PRECEDES, its beginning is `timestamp`.
        // The decoder's internal `lastSignalTime` should still reflect the end of the *previous* element until this new mark concludes.
    }

    // Call this when a signal ends (key up)
    signalEnd(timestamp) {
        console.log(`[Decoder ${this.id}] signalEnd called at ${timestamp}. Last signal time: ${this.lastSignalTime}`);
        if (this.lastSignalTime === 0) {
             console.warn(`[Decoder ${this.id}] signalEnd called without prior signalStart or with reset lastSignalTime.`);
             this.lastSignalTime = timestamp - this.unitTime; // Try to recover reasonably
        }

        const onDuration = timestamp - this.lastSignalTime;
        // this.lastSignalTime = timestamp; // This will be set at the end of the method

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
        this.lastSignalTime = timestamp; // This correctly sets the end of the current mark
        console.log(`[Decoder ${this.id}] Mark processed. Updated lastSignalTime to ${this.lastSignalTime}`);
    }

    processSilence(duration) {
        console.log(`[Decoder ${this.id}] processSilence called with duration: ${duration.toFixed(2)}ms. Current pattern: '${this.currentMorsePattern}'. unitTime: ${this.unitTime.toFixed(2)}ms. Original lastSignalTime: ${this.lastSignalTime}`);
        const originalLastSignalTime = this.lastSignalTime; // Time at the end of the last mark

        if (duration < 0) { 
            console.warn(`[Decoder ${this.id}] Negative silence duration ${duration}ms. Ignoring. Timestamps might be out of order.`);
            return; 
        }

        if (this.currentMorsePattern === '') {
            console.log(`[Decoder ${this.id}] No current pattern to process with this silence.`);
            // If there's no pattern, this silence just extends the period since the last mark (or start).
            // Update lastSignalTime to the end of this silence period.
            this.lastSignalTime = originalLastSignalTime + duration;
            console.log(`[Decoder ${this.id}] No pattern, silence processed. Updated lastSignalTime to ${this.lastSignalTime}`);
            return;
        }

        if (duration > this.unitTime * this.MEDIUM_SPACE_RATIO) { // Word space
            console.log(`[Decoder ${this.id}] Interpreted as WORD_SPACE (>${(this.unitTime * this.MEDIUM_SPACE_RATIO).toFixed(2)}ms).`);
            this.decodeCurrentPattern(); // This resets currentMorsePattern
            this.onDecodedChar(' ');
            this.lastSignalTime = originalLastSignalTime + duration; // Mark end of word space
            console.log(`[Decoder ${this.id}] Word space processed. Updated lastSignalTime to ${this.lastSignalTime}`);
        } else if (duration > this.unitTime * this.SHORT_SPACE_RATIO) { // Character space
            console.log(`[Decoder ${this.id}] Interpreted as CHARACTER_SPACE (>${(this.unitTime * this.SHORT_SPACE_RATIO).toFixed(2)}ms).`);
            this.decodeCurrentPattern(); // This resets currentMorsePattern
            this.lastSignalTime = originalLastSignalTime + duration; // Mark end of char space
            console.log(`[Decoder ${this.id}] Char space processed. Updated lastSignalTime to ${this.lastSignalTime}`);
        } else if (duration > this.unitTime * this.INTER_ELEMENT_SPACE_RATIO) {
            console.log(`[Decoder ${this.id}] Interpreted as INTER_ELEMENT_SPACE (>${(this.unitTime * this.INTER_ELEMENT_SPACE_RATIO).toFixed(2)}ms). Pattern preserved.`);
            // Pattern preserved. lastSignalTime is NOT updated here, it's still end of last mark for calculation of next element's silence.
            // However, if subsequent calls to processSilence occur without an intervening signalEnd, this.lastSignalTime *should* be end of this space.
            // For now, we assume signalEnd or another signalStart will follow. If this assumption is wrong, this logic might need refinement.
            // The current VailClient logic calls signalStart before signalEnd for a mark, and processSilence is called by signalStart.
            // If VailClient calls signalStart(notice_time) for a notice, then processSilence is called. This path needs to ensure lastSignalTime is updated.
             this.lastSignalTime = originalLastSignalTime + duration; 
             console.log(`[Decoder ${this.id}] Inter-element space. Updated lastSignalTime to ${this.lastSignalTime} to reflect end of this space.`);

        } else {
            console.log(`[Decoder ${this.id}] Silence too short (${duration.toFixed(2)}ms), considered part of current pattern or noise. lastSignalTime remains ${this.lastSignalTime}.`);
            // Pattern preserved. lastSignalTime is NOT updated here.
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

       if (this.signalBuffer.length < this.MIN_SIGNALS_FOR_UNIT_TIME_UPDATE) {
           console.log(`[Decoder ${this.id}] updateUnitTime: Signal buffer has ${this.signalBuffer.length} elements, less than required ${this.MIN_SIGNALS_FOR_UNIT_TIME_UPDATE}. unitTime remains ${this.unitTime.toFixed(2)}ms.`);
           return;
       }

       let sortedSignals = [...this.signalBuffer].sort((a, b) => a - b);
       const potentialDits = sortedSignals.filter(s => s < ( (sortedSignals[Math.floor(sortedSignals.length / 2)] || this.unitTime * 1.5) * this.DIT_DAH_RATIO_THRESHOLD));

       if (potentialDits.length > 0) {
           const numToAverage = Math.max(1, Math.floor(potentialDits.length / 3));
           const sum = potentialDits.slice(0, numToAverage).reduce((acc, val) => acc + val, 0);
           this.unitTime = Math.max(20, sum / numToAverage); // Min 20ms unit time
           console.log(`[Decoder ${this.id}] updateUnitTime: Buffer: [${this.signalBuffer.join(', ')}]. Potential dits: [${potentialDits.join(', ')}]. New unitTime: ${this.unitTime.toFixed(2)}ms (was ${oldUnitTime.toFixed(2)}ms).`);
       } else if (this.signalBuffer.length > 0) {
           console.log(`[Decoder ${this.id}] updateUnitTime: Buffer: [${this.signalBuffer.join(', ')}]. No potential dits found. unitTime remains ${this.unitTime.toFixed(2)}ms.`);
       } else {
           // This case should ideally not be reached if the initial buffer length check is done.
           console.log(`[Decoder ${this.id}] updateUnitTime: Signal buffer empty. unitTime remains ${this.unitTime.toFixed(2)}ms.`);
       }
   }

    // Call this if there's a long pause or a timeout to force decoding of the last pattern
    forceDecode() {
        console.log(`[Decoder ${this.id}] forceDecode called. Current pattern: '${this.currentMorsePattern}'. Simulating long silence.`);
        this.processSilence(this.unitTime * (this.MEDIUM_SPACE_RATIO + 1)); // Simulate a long space
    }
}
