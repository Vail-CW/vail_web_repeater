/**
 * Morse Code Decoder Integration for Vail Repeater
 *
 * This module wraps the morse-pro adaptive decoder library to provide
 * live decoding of morse code transmissions in decoder-enabled rooms.
 */

import MorseAdaptiveDecoder from './morse-pro-decoder-adaptive.mjs'

/**
 * VailDecoder manages morse code decoding for a Vail repeater room.
 * It handles timing input from Duration arrays and outputs decoded text.
 */
export class VailDecoder {
    /**
     * @param {Function} textCallback - Called when text is decoded: (text, callsign, timestamp) => {}
     * @param {number} initialWPM - Initial WPM estimate (default: 20)
     * @param {number} bufferSize - Adaptive buffer size (default: 30)
     */
    constructor(textCallback, initialWPM = 20, bufferSize = 30) {
        this.textCallback = textCallback
        this.enabled = true
        this.currentCallsign = ""
        this.currentTimestamp = 0
        this.lastToneEndTime = 0  // Track when last tone ended (for calculating spaces)
        this.flushTimer = null  // Timer to flush pending characters

        // Create the adaptive decoder
        this.decoder = new MorseAdaptiveDecoder(
            initialWPM,  // Initial WPM guess
            initialWPM,  // Farnsworth WPM (same as regular for now)
            bufferSize,  // Buffer size for adaptive algorithm
            (message) => this.handleDecodedMessage(message),
            (speed) => this.handleSpeedUpdate(speed)
        )

        this.currentSpeed = { wpm: initialWPM, fwpm: initialWPM }
    }

    /**
     * Process morse code timing from a Duration array
     * @param {Array<number>} durations - Array of tone ON/OFF durations in milliseconds
     * @param {string} callsign - Callsign of the sender
     * @param {number} timestamp - Timestamp of the transmission
     */
    addDurations(durations, callsign = "", timestamp = 0) {
        if (!this.enabled || !durations || durations.length === 0) {
            return
        }

        // Store metadata for when we decode text
        this.currentCallsign = callsign

        // Calculate space since last tone (if this isn't the first tone)
        if (this.lastToneEndTime > 0 && timestamp > this.lastToneEndTime) {
            const spaceBeforeTone = timestamp - this.lastToneEndTime
            this.decoder.addTiming(-spaceBeforeTone)  // Negative = silence
        }

        // Process the Duration array
        // In Vail's protocol, Duration alternates: [tone_on, space, tone_on, space, ...]
        // But often it's just a single tone: [duration]
        let currentTime = timestamp
        let isOn = true

        for (let duration of durations) {
            if (duration > 0) {
                const timing = isOn ? duration : -duration
                this.decoder.addTiming(timing)
                currentTime += duration
            }
            isOn = !isOn
        }

        // Update last tone end time
        this.lastToneEndTime = currentTime

        // Set a timer to flush pending characters after 2 seconds of silence
        // This helps output complete words/characters even if sender pauses
        if (this.flushTimer) {
            clearTimeout(this.flushTimer)
        }
        this.flushTimer = setTimeout(() => {
            this.flush()
        }, 2000)
    }

    /**
     * Called by morse-pro when text is decoded
     * @private
     */
    handleDecodedMessage(message) {
        // morse-pro returns message.message (not message.text!)
        const text = message.message || message.text
        if (this.textCallback && text) {
            // Call user's callback with decoded text
            this.textCallback(text, this.currentCallsign, this.currentTimestamp)
        }
    }

    /**
     * Called by morse-pro when speed estimate changes
     * @private
     */
    handleSpeedUpdate(speed) {
        this.currentSpeed = speed
    }

    /**
     * Get current estimated speed
     * @returns {{wpm: number, fwpm: number}}
     */
    getSpeed() {
        return this.currentSpeed
    }

    /**
     * Enable or disable decoding
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        this.enabled = enabled
    }

    /**
     * Flush any pending decoded characters
     */
    flush() {
        if (this.decoder && this.decoder.flush) {
            this.decoder.flush()
        }
    }

    /**
     * Reset the decoder state
     */
    reset() {
        // Recreate the decoder to reset all state
        const wpm = this.currentSpeed.wpm
        this.decoder = new MorseAdaptiveDecoder(
            wpm,
            wpm,
            30,
            (message) => this.handleDecodedMessage(message),
            (speed) => this.handleSpeedUpdate(speed)
        )
        this.lastToneEndTime = 0
    }
}