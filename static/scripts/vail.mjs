import * as Keyers from "./keyers.mjs"
import * as Outputs from "./outputs.mjs"
import * as Inputs from "./inputs.mjs"
import * as Repeaters from "./repeaters.mjs"
import * as Chart from "./chart.mjs"
import * as I18n from "./i18n.mjs"
import * as time from "./time.mjs"
import * as Music from "./music.mjs"
import * as Icon from "./icon.mjs"
import * as Noise from "./noise.mjs"
import { MorseDecoder } from './decoder.mjs';

const DefaultRepeater = "General"

console.warn("Chrome will now complain about an AudioContext not being allowed to start. This is normal, and there is no way to make Chrome stop complaining about this.")
const globalAudioContext = new AudioContext({
	latencyHint: "interactive",
})

function initLog(message) {
	for (let modal of document.querySelectorAll(".modal.init")) {
		if (!message) {
			modal.remove()
		} else {
			let ul = modal.querySelector("ul")
			while (ul.childNodes.length > 5) {
				ul.firstChild.remove()
			}
			let li = ul.appendChild(document.createElement("li"))
			li.textContent = message
			}
	}
}

/**
 * Pop up a message, using an notification.
 * 
 * @param {string} msg Message to display
 */
function toast(msg, timeout=4*time.Second) {
	console.info(msg)

	let errors = document.querySelector("#errors")
	let p = errors.appendChild(document.createElement("p"))
	p.textContent = msg
	setTimeout(() => p.remove(), timeout)
}

// iOS kludge
if (!window.AudioContext) {
	window.AudioContext = window.webkitAudioContext
}

class VailClient {
	constructor() {
		this.sent = []
		this.lagTimes = [0]
		this.rxDurations = [0]
		this.clockOffset = null // How badly our clock is off of the server's
		this.rxDelay = 0 * time.Millisecond // Time to add to incoming timestamps
		this.beginTxTime = null // Time when we began transmitting

		initLog("Initializing outputs")
		this.outputs = new Outputs.Collection(globalAudioContext)
		this.outputs.connect(globalAudioContext.destination)

		initLog("Starting up noise")
		this.noise = new Noise.Noise(globalAudioContext)
		this.noise.connect(globalAudioContext.destination)

		initLog("Setting app icon name")
		this.icon = new Icon.Icon()

		initLog("Initializing keyers")
		this.straightKeyer = new Keyers.Keyers.straight(this)
		this.keyer = new Keyers.Keyers.straight(this)
		this.roboKeyer = new Keyers.Keyers.robo(() => this.Buzz(), () => this.Silence())

		// Send this as the keyer so we can intercept dit and dah events for charts
		initLog("Setting up input methods")
		this.inputs = new Inputs.Collection(this)

		const specialKeyMappings = {
			"BracketLeft": 120,  // [
			"BracketRight": 121, // ]
			"Backslash": 122,    // \
			"Slash": 123,        // /
			"ShiftLeft": 124,
			"ShiftRight": 125,
			"ControlLeft": 126,  // Default Dit
			"ControlRight": 127  // Default Dah
		};
		this.specialKeyMappings = specialKeyMappings; // Make it accessible via this if needed later

		// Staging variables for "Save" button functionality
		this.stagedDit = { code: "ControlLeft", key: "Control", midiValue: 126 }; // Default
		this.stagedDah = { code: "ControlRight", key: "Control", midiValue: 127 }; // Default

		initLog("Listening on AudioContext")
		document.body.addEventListener(
			"click",
			e => globalAudioContext.resume(),
			true,
		)

		initLog('Setting up maximize button')
		for (let e of document.querySelectorAll("button.maximize")) {
			e.addEventListener("click", e => this.maximize(e))
		}
		for (let e of document.querySelectorAll("#reset")) {
			e.addEventListener("click", e => this.reset())
		}

		initLog("Initializing knobs")
		this.inputInit("#keyer-mode", e => this.setKeyer(e.target.value))
		this.inputInit("#keyer-rate", e => {
			let rate = e.target.value
			this.ditDuration = Math.round(time.Minute / rate / 50)
			for (let e of document.querySelectorAll("[data-fill='keyer-ms']")) {
				e.textContent = this.ditDuration
			}
			this.keyer.SetDitDuration(this.ditDuration)
			this.roboKeyer.SetDitDuration(this.ditDuration)
			this.inputs.SetDitDuration(this.ditDuration)

          // Add this line to update the decoder
          if (this.morseDecoder) {
              this.morseDecoder.setUnitTime(this.ditDuration);
          }
		})
		this.inputInit("#rx-delay", e => { 
			this.rxDelay = e.target.value * time.Second
		})
		this.inputInit("#masterGain", e => {
			this.outputs.SetGain(e.target.value / 100)
		})
		this.inputInit("#noiseGain", e => {
			this.noise.SetGain(e.target.value / 100)
		})
		let toneTransform = {
			note: Music.MIDINoteName,
			freq: Music.MIDINoteFrequency,
		}
		this.inputInit(
			"#rx-tone", 
			e => {
				this.noise.SetNoiseFrequency(1, Music.MIDINoteFrequency(e.target.value))
				this.outputs.SetMIDINote(false, e.target.value)
			},
			toneTransform,
		)
		this.inputInit(
			"#tx-tone", 
			e => this.outputs.SetMIDINote(true, e.target.value),
			toneTransform,
		)
		this.inputInit("#telegraph-buzzer", e => {
			this.setTelegraphBuzzer(e.target.checked)
		})
		this.inputInit("#notes")

		// ---- START: Keybinding input logic ----
		const ditKeyInput = document.querySelector("#dit-key-input");
		const dahKeyInput = document.querySelector("#dah-key-input");

		if (ditKeyInput) {
			ditKeyInput.value = this.stagedDit.key;
			ditKeyInput.placeholder = "Click and press a key for DIT";
			// ditKeyInput.readOnly = true; // Optional: make field initially readonly
			ditKeyInput.addEventListener("keydown", (event) => {
				event.preventDefault();
				event.stopPropagation();

				const keyCode = event.keyCode;
				const key = event.key;
				const code = event.code;

				let midiValueToSend;
				let displayValue = key;

				if (this.specialKeyMappings.hasOwnProperty(code)) {
					midiValueToSend = this.specialKeyMappings[code];
				} else {
					midiValueToSend = keyCode;
				}

				if (midiValueToSend < 0 || midiValueToSend > 127) {
					ditKeyInput.value = key + " (Not MIDI Bindable)";
				} else {
					ditKeyInput.value = displayValue;
					this.stagedDit = { code: code, key: displayValue, midiValue: midiValueToSend };
				}
				ditKeyInput.blur();
			});
		}

		if (dahKeyInput) {
			dahKeyInput.value = this.stagedDah.key;
			dahKeyInput.placeholder = "Click and press a key for DAH";
			// dahKeyInput.readOnly = true; // Optional
			dahKeyInput.addEventListener("keydown", (event) => {
				event.preventDefault();
				event.stopPropagation();

				const keyCode = event.keyCode;
				const key = event.key;
				const code = event.code;

				let midiValueToSend;
				let displayValue = key;

				if (this.specialKeyMappings.hasOwnProperty(code)) {
					midiValueToSend = this.specialKeyMappings[code];
				} else {
					midiValueToSend = keyCode;
				}

				if (midiValueToSend < 0 || midiValueToSend > 127) {
					dahKeyInput.value = key + " (Not MIDI Bindable)";
				} else {
					dahKeyInput.value = displayValue;
					this.stagedDah = { code: code, key: displayValue, midiValue: midiValueToSend };
				}
				dahKeyInput.blur();
			});
		}

		const saveButton = document.querySelector("#save-keybindings-button");
		if (saveButton) {
			saveButton.addEventListener("click", () => {
				if (this.inputs && this.inputs.midi) {
					if (this.stagedDit && typeof this.stagedDit.midiValue !== 'undefined') {
						this.inputs.midi.sendKeyBinding(3, this.stagedDit.midiValue);
						// console.log("Attempted to save DIT:", this.stagedDit);
					} else {
						// console.warn("No staged DIT key to save or midiValue is undefined.");
					}

					if (this.stagedDah && typeof this.stagedDah.midiValue !== 'undefined') {
						this.inputs.midi.sendKeyBinding(4, this.stagedDah.midiValue);
						// console.log("Attempted to save DAH:", this.stagedDah);
					} else {
						// console.warn("No staged DAH key to save or midiValue is undefined.");
					}
					// toast("Key bindings sent to adapter.", 2000); // Example
				} else {
					// console.warn("MIDI system not available. Cannot save key bindings.");
					// toast("MIDI system not available.", 3000);
				}
			});
		}

		const defaultsButton = document.querySelector("#defaults-keybindings-button");
		if (defaultsButton) {
			defaultsButton.addEventListener("click", () => {
				const defaultDitCode = "ControlLeft";
				const defaultDitKeyDisplay = "Control";
				const defaultDitMidiValue = this.specialKeyMappings[defaultDitCode];

				const defaultDahCode = "ControlRight";
				const defaultDahKeyDisplay = "Control";
				const defaultDahMidiValue = this.specialKeyMappings[defaultDahCode];

				this.stagedDit = { code: defaultDitCode, key: defaultDitKeyDisplay, midiValue: defaultDitMidiValue };
				this.stagedDah = { code: defaultDahCode, key: defaultDahKeyDisplay, midiValue: defaultDahMidiValue };

				const ditKeyInput = document.querySelector("#dit-key-input");
				const dahKeyInput = document.querySelector("#dah-key-input");
				if (ditKeyInput) {
					ditKeyInput.value = this.stagedDit.key;
				}
				if (dahKeyInput) {
					dahKeyInput.value = this.stagedDah.key;
				}

				if (this.inputs && this.inputs.midi) {
					this.inputs.midi.sendKeyBinding(3, this.stagedDit.midiValue);
					this.inputs.midi.sendKeyBinding(4, this.stagedDah.midiValue);
					// console.log("Defaults set and sent to adapter.");
					// toast("Default key bindings restored and sent.", 2000);
				} else {
					// console.warn("MIDI system not available. Cannot send default key bindings.");
					// toast("MIDI system not available. Defaults set locally.", 3000);
				}
			});
		}
		// ---- END: Keybinding input logic ----

		// Initialize Morse Decoder and related properties AFTER inputInit for keyer-rate
		initLog("Initializing Morse Decoder");
		this.decoderOutputElement = document.querySelector("#decoder-output");
		
		// Ensure keyer-rate's initial 'input' event has fired to set this.ditDuration
		// The inputInit for keyer-rate should have run and set this.ditDuration
		// If this.ditDuration is not yet set, provide a fallback or ensure init order.
		// For safety, check if this.ditDuration is set, or use a default.
		const initialDecoderUnitTime = this.ditDuration || 100; // 100ms if ditDuration somehow not set yet
		
		this.morseDecoder = new MorseDecoder((char) => {
			this.updateDecodedOutput(char);
		}, initialDecoderUnitTime); // Pass initial unit time
		console.log(`[VailClient] Initialized MorseDecoder with unitTime: ${initialDecoderUnitTime.toFixed(2)}ms`);

		this.lastReceiveTime = 0; // To keep track of the end time of the last received signal portion
		this.lastSignalTime = Date.now(); // Initial reference for first silence calculation
		this.decodingTimeout = null; // For forceDecode timeout

		// Decoder Output Toggle
		this.toggleDecoderButton = document.querySelector("#toggle-decoder-output");
		if (this.toggleDecoderButton) {
			this.decoderOutputIcon = this.toggleDecoderButton.querySelector("i"); // Now safe

			let decoderVisible = localStorage.getItem('decoderVisible') !== 'false';

			const updateDecoderVisibility = (visible) => {
				if (this.decoderOutputElement) { // Guard for decoderOutputElement
					if (visible) {
						this.decoderOutputElement.classList.remove('is-hidden');
						if (this.decoderOutputIcon) { // Guard for decoderOutputIcon
							this.decoderOutputIcon.classList.remove('mdi-eye-off');
							this.decoderOutputIcon.classList.add('mdi-eye');
						}
						// toggleDecoderButton is known to be non-null here
						this.toggleDecoderButton.setAttribute('title', 'Hide decoded output');
					} else {
						this.decoderOutputElement.classList.add('is-hidden');
						if (this.decoderOutputIcon) { // Guard for decoderOutputIcon
							this.decoderOutputIcon.classList.remove('mdi-eye');
							this.decoderOutputIcon.classList.add('mdi-eye-off');
						}
						// toggleDecoderButton is known to be non-null here
						this.toggleDecoderButton.setAttribute('title', 'Show decoded output');
					}
				}
			};
			updateDecoderVisibility(decoderVisible); // Safe to call if toggleDecoderButton exists

			this.toggleDecoderButton.addEventListener('click', () => {
				// This listener is only added if toggleDecoderButton exists, so it's safe to use it here.
				let currentVisibility = this.decoderOutputElement ? !this.decoderOutputElement.classList.contains('is-hidden') : false;
				decoderVisible = !currentVisibility;
				updateDecoderVisibility(decoderVisible);
				localStorage.setItem('decoderVisible', decoderVisible);
			});
		} else {
			console.warn("#toggle-decoder-output button not found. Decoder toggle UI will be disabled.");
			this.decoderOutputIcon = null; // Ensure it's null if button not found
		}

		initLog("Filling in repeater name")
		document.querySelector("#repeater").addEventListener("change", e => this.setRepeater(e.target.value.trim()))
		window.addEventListener("hashchange", () => this.hashchange())
		this.hashchange()
	
		initLog("Starting timing charts")
		this.setTimingCharts(true)

		initLog("Setting up mute icon")
		globalAudioContext.resume()
		.then(() => {
			for (let e of document.querySelectorAll(".muted")) {
				e.classList.add("is-hidden")
			}
		})
	}

	updateDecodedOutput(char) {
		if (this.decoderOutputElement) {
			this.decoderOutputElement.textContent += char;
			// Optional: Auto-scroll
			this.decoderOutputElement.scrollTop = this.decoderOutputElement.scrollHeight;
		}
	}
	
	/**
	 * Straight key change (keyer shim)
	 * 
	 * @param down If key has been depressed
	 */
	Straight(down) {
		this.straightKeyer.Key(0, down)
	}

	/**
	 * Key/paddle change
	 * 
	 * @param {Number} key Key which was pressed
	 * @param {Boolean} down True if key was pressed
	 */
	Key(key, down) {
		this.keyer.Key(key, down)
		if (this.keyCharts) this.keyCharts[key].Set(down?1:0)
	}

	setKeyer(keyerName) {
		let newKeyerClass = Keyers.Keyers[keyerName]
		let newKeyerNumber = Keyers.Numbers[keyerName]
		if (!newKeyerClass) {
			console.error("Keyer not found", keyerName)
			return
		}
		let newKeyer = new newKeyerClass(this)
		let i = 0
		for (let keyName of newKeyer.KeyNames()) {
			let e = document.querySelector(`.key[data-key="${i}"]`)
			e.textContent = keyName
			i += 1
		}
		this.keyer.Release()
		this.keyer = newKeyer

		this.inputs.SetKeyerMode(newKeyerNumber)

		document.querySelector("#keyer-rate").dispatchEvent(new Event("input"))
	}

	Buzz() {
		this.outputs.Buzz(false)
		this.icon.Set("rx")

		if (this.rxChart) this.rxChart.Set(1)
	}

	Silence() {
		this.outputs.Silence()
		if (this.rxChart) this.rxChart.Set(0)
	}

	BuzzDuration(tx, when, duration) {
		this.outputs.BuzzDuration(tx, when, duration)

		let chart
		if (tx) {
			chart = this.txChart
		} else {
			chart = this.rxChart
			this.icon.SetAt("rx", when)
		}
		if (chart) {
			chart.SetAt(1, when)
			chart.SetAt(0, when+duration)
		}
	}

	/**
	 * Start the side tone buzzer.
	 * 
	 * Called from the keyer.
	 */
	BeginTx() {
       const now = Date.now();
       if (!this.beginTxTime) { 
            this.beginTxTime = now;
       }
       this.outputs.Buzz(true);

       if (this.decodingTimeout) {
           clearTimeout(this.decodingTimeout);
           this.decodingTimeout = null;
       }
       if (this.morseDecoder) {
           this.morseDecoder.signalStart(now);
       }
       this.lastSignalTime = now; 

       if (this.txChart) this.txChart.Set(1);
   }

	/**
	 * Stop the side tone buzzer, and send out how long it was active.
	 * 
	 * Called from the keyer
	 */
	EndTx() {
       if (!this.beginTxTime) {
           return;
       }
       const now = Date.now();
       let duration = now - this.beginTxTime; 
       
       this.outputs.Silence(true);
       if (this.repeater) {
           this.repeater.Transmit(this.beginTxTime, duration);
       } else {
           console.warn("EndTx called but repeater is not initialized. Transmission ignored.");
       }
       
       if (this.morseDecoder) {
           this.morseDecoder.signalEnd(now);
       }
       this.lastSignalTime = now;
       this.resetDecodingTimeout(); 

       this.beginTxTime = null; 
       if (this.txChart) this.txChart.Set(0);
   }

	resetDecodingTimeout() {
       if (this.decodingTimeout) {
           clearTimeout(this.decodingTimeout);
           this.decodingTimeout = null;
       }

       let timeoutDuration = 1000; // Default fallback timeout
       if (this.morseDecoder && this.morseDecoder.unitTime > 0 && this.morseDecoder.MEDIUM_SPACE_RATIO > 0) {
           timeoutDuration = this.morseDecoder.unitTime * (this.morseDecoder.MEDIUM_SPACE_RATIO + 2);
       }

       if (this.morseDecoder) {
           this.decodingTimeout = setTimeout(() => {
               if (this.morseDecoder) {
                   console.log("Timeout: Forcing decode. Current pattern:", this.morseDecoder.currentMorsePattern, "LastSignalTime:", this.lastSignalTime);
                   this.morseDecoder.forceDecode();
                   // No need to update this.lastSignalTime here; let actual signal events manage it.
               }
           }, timeoutDuration);
       }
   }

	/**
	 * Toggle timing charts.
	 * 
	 * @param enable True to enable charts
	 */
	setTimingCharts(enable) {
		// XXX: UI code shouldn't be in the Keyer class.
		// Actually, the charts calls should be in vail
		let chartsContainer = document.querySelector("#charts")
		if (!chartsContainer) {
			return
		}
		if (enable) {
			chartsContainer.classList.remove("hidden")
			this.keyCharts = [
				Chart.FromSelector("#key0Chart"),
				Chart.FromSelector("#key1Chart")
			]
			this.txChart = Chart.FromSelector("#txChart")
			this.rxChart = Chart.FromSelector("#rxChart")
		} else {
			chartsContainer.classList.add("hidden")
			this.keyCharts = []
			this.txChart = null
			this.rxChart = null
		}
	}

	/**
	 * Toggle the clicktastic buzzer, instead of the beeptastic one.
	 * 
	 * @param {bool} enable true to enable clicky buzzer
	 */
	setTelegraphBuzzer(enable) {
		if (enable) {
			this.outputs.SetAudioType("telegraph")
			toast("Telegraphs only make sound when receiving!")
		} else {
			this.outputs.SetAudioType()
		}
	}

	/**
	 * Called when the hash part of the URL has changed.
	 */
	hashchange() {
		let hashParts = window.location.hash.split("#")
		
		this.setRepeater(decodeURIComponent(hashParts[1] || ""))
	}

	/**
	 * Connect to a repeater by name.
	 * 
	 * This does some switching logic to provide multiple types of repeaters,
	 * like the Fortunes repeaters.
	 * 
	 * @param {string} name Repeater name
	 */
	setRepeater(name) {
		if (this.morseDecoder) {
			this.morseDecoder.reset();
			if (this.decoderOutputElement) { // Guard already present from previous step, but good to confirm
				this.decoderOutputElement.textContent = ''; // Clear UI
			}
		}
		if (this.decodingTimeout) clearTimeout(this.decodingTimeout); // Clear any pending forceDecode

		if (!name || (name == "")) {
			name = DefaultRepeater
		}
		this.repeaterName = name

		// Set value of repeater element
		let repeaterElement = document.querySelector("#repeater")
		let paps = repeaterElement.parentElement
		if (paps.MaterialTextfield) {
			paps.MaterialTextfield.change(name)
		} else {
			repeaterElement.value = name
		}

		// Set window URL
		let prevHash = window.location.hash
		window.location.hash = (name == DefaultRepeater) ? "" : name
		if (window.location.hash != prevHash) {
			// We're going to get a hashchange event, which will re-run this method
			return
		}
		
		this.Silence()
		if (this.repeater) {
			this.repeater.Close()
		}
		let rx = (w,d,s) => this.receive(w,d,s)

		// If there's a number in the name, store that for potential later use
		let numberMatch = name.match(/[0-9]+/)
		let number = 0
		if (numberMatch) {
			number = Number(numberMatch[0])
		}

		if (name.startsWith("Fortunes")) {
			this.roboKeyer.SetPauseMultiplier(number || 1)
			this.repeater = new Repeaters.Fortune(rx, this.roboKeyer)
		} else if (name.startsWith("Echo")) {
			this.repeater = new Repeaters.Echo(rx)
		} else if (name == "Null") {
			this.repeater = new Repeaters.Null(rx)
		} else {
			this.repeater = new Repeaters.Vail(rx, name)
		}
	}

	/**
	 * Set up an HTML input element.
	 * 
	 * This reads any previously saved value and sets the input value to that.
	 * When the input is updated, it saves the value it's updated to,
	 * and calls the provided callback with the new value.
	 * 
	 * @param {string} selector CSS path to the element
	 * @param {function} callback Callback to call with any new value that is set
	 * @param {Object.<string, function>} transform Transform functions
	 */
	inputInit(selector, callback, transform={}) {
		let element = document.querySelector(selector)
		if (!element) {
			console.warn("Unable to find an input to init", selector)
			return
		}
		let storedValue = localStorage[element.id]
		if (storedValue != null) {
			element.value = storedValue
			element.checked = (storedValue == "on")
		}
		let id = element.id
		let outputElements = document.querySelectorAll(`[for="${id}"]`)

		element.addEventListener("input", e => {
			let value = element.value
			if (element.type == "checkbox") {
				value = element.checked?"on":"off"
			}
			localStorage[element.id] = value

			for (let e of outputElements) {
				if (e.dataset.transform) {
					let tf = transform[e.dataset.transform]
					e.value = tf(value)
				} else {
					e.value = value
				}
			}
			if (callback) {
				callback(e)
			}
		})
		element.dispatchEvent(new Event("input"))
	}

	/**
	 * Make an error sound and pop up a message
	 * 
	 * @param {string} msg The message to pop up
	 */
	error(msg) {
		toast(msg)
		this.outputs.Error()
	}

	/**
	 * Called by a repeater class when there's something received.
	 * 
	 * @param {number} when When to play the tone
	 * @param {number} duration How long to play the tone
	 * @param {dict} stats Stuff the repeater class would like us to know about
	 */
	receive(when, duration, stats) {
    this.clockOffset = stats.clockOffset || "?";
    const now = Date.now(); // Current time for checks like "too old"
    const effectiveWhen = when + this.rxDelay;

    if (this.decodingTimeout) {
        clearTimeout(this.decodingTimeout);
        this.decodingTimeout = null;
    }

    if (effectiveWhen < (now - 20000) && when !== 0) { // Allow when=0 for notices, 20s arbitrary cutoff
        console.warn(`[VailClient.receive] Stale signal received. Effective time: ${effectiveWhen}, Current time: ${now}. Difference: ${now - effectiveWhen}ms. Ignoring.`);
        // Do not process stale signals further to prevent decoder confusion, but still reset timeout later.
    } else {
        if (effectiveWhen < now && when !== 0) { // Still log if slightly old for audio, but process for decoder
            console.warn(`[VailClient.receive] Old signal for audio. Effective time: ${effectiveWhen}, Current time: ${now}. Difference: ${now - effectiveWhen}ms.`);
            // Not calling this.error() here anymore to let decoder attempt processing.
        }

        // Let decoder.signalStart handle the silence duration before this event.
        // effectiveWhen is the timestamp of the beginning of the potential mark or the time of a notice.
        if (this.morseDecoder) {
            this.morseDecoder.signalStart(effectiveWhen);
        }

        if (duration > 0) { // It's a mark (tone)
            if (this.morseDecoder) {
                this.morseDecoder.signalEnd(effectiveWhen + duration);
            }
            this.lastSignalTime = effectiveWhen + duration; // Update VailClient's lastSignalTime

            this.BuzzDuration(false, effectiveWhen, duration); // Audio playback

            this.rxDurations.unshift(duration); // For stats
            this.rxDurations.splice(20, 2);
            this.lastReceiveTime = effectiveWhen + duration; // Legacy tracking, might be redundant with lastSignalTime now
        } else { // It's a notice or non-mark event (duration == 0)
            this.lastSignalTime = effectiveWhen; // Update VailClient's lastSignalTime to the time of the notice
             // No mark to process with signalEnd. The preceding silence up to effectiveWhen was handled by signalStart.
        }
    }

    if (stats.notice) {
        toast(stats.notice);
    }

    // Stats updates (averageLag, longestRxDuration, etc.)
    let averageLag = (stats.averageLag || 0).toFixed(2);
    let longestRxDuration = 0;
    if (this.rxDurations.length > 0) {
        longestRxDuration = this.rxDurations.reduce((a, b) => Math.max(a, b));
    }
    let suggestedDelay = ((parseFloat(averageLag) + longestRxDuration) * 1.2).toFixed(0);

    if (stats.connected !== undefined) {
        this.outputs.SetConnected(stats.connected);
    }
    this.updateReading("#note", stats.note || stats.clients || "😎");
    this.updateReading("#lag-value", averageLag);
    this.updateReading("#longest-rx-value", longestRxDuration);
    this.updateReading("#suggested-delay-value", suggestedDelay);
    this.updateReading("#clock-off-value", this.clockOffset);

    this.resetDecodingTimeout(); // Schedule forceDecode for end of transmission
}

	/**
	 * Update an element with a value, if that element exists
	 * 
	 * @param {string} selector CSS path to the element
	 * @param value Value to set
	 */
	updateReading(selector, value) {
		let e = document.querySelector(selector)
		if (e) {
			e.value = value
		}
	}

	/**
	 * Maximize/minimize a card
	 * 
	 * @param e Event
	 */
	maximize(e) {
		let element = e.target
		while (!element.classList.contains("mdl-card")) {
			element = element.parentElement
			if (!element) {
				console.log("Maximize button: couldn't find parent card")
				return
			}
		}
		element.classList.toggle("maximized")
		console.log(element)
	}

	/** Reset to factory defaults */
	reset() {
		localStorage.clear()
		location.reload()
	}
}

async function init() {
	initLog("Starting service worker")
	if (navigator.serviceWorker) {
		navigator.serviceWorker.register("scripts/sw.js")
	}

	initLog("Setting up internationalization")
	await I18n.Setup()

	initLog("Creating client")
	try {
		window.app = new VailClient()
	} catch (err) {
		console.log(err)
		toast(err)
	}
	initLog(false)
}


if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init)
} else {
	init()
}

// vim: noet sw=2 ts=2
