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
import {VailDecoder} from "./decoder.mjs"

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
		this.breakInEnabled = false // Whether break-in (broadcasting) is enabled
		this.seenMessages = new Set() // Track seen chat messages to prevent duplicates
		this.txTone = 72 // Default TX tone (C5)
		this.decoder = null // Morse code decoder (enabled for Decoder room)
		this.adminCallsigns = [] // Admin callsigns loaded from server

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
			"#tx-tone",
			e => {
				// Store TX tone to send with transmissions
				this.txTone = parseInt(e.target.value)
				// Send MIDI CC 0x02 to save to adapter EEPROM
				this.outputs.SetMIDINote(true, e.target.value)
				// Update the repeater with new TX tone
				if (this.repeater && this.repeater.SetTxTone) {
					this.repeater.SetTxTone(this.txTone)
				}
			},
			toneTransform,
		)
		this.inputInit("#telegraph-buzzer", e => {
			this.setTelegraphBuzzer(e.target.checked)
		})
		this.inputInit("#notes")

		// Set up break-in toggle (don't use inputInit to avoid saving to localStorage)
		initLog("Setting up break-in toggle")
		this.breakInField = document.querySelector("#break-in-field")
		let breakInToggle = document.querySelector("#break-in-toggle")
		if (breakInToggle) {
			breakInToggle.addEventListener("change", e => {
				this.breakInEnabled = e.target.checked
				// Remove warning when enabled
				if (this.breakInEnabled && this.breakInField) {
					this.breakInField.classList.remove("transmitting-warning")
				}
			})
		}

		initLog("Initializing callsign")
		// Generate anonymous callsign if none exists
		let savedCallsign = localStorage.getItem("callsign")
		if (!savedCallsign) {
			// Generate random 4-digit number
			let randomNum = Math.floor(1000 + Math.random() * 9000)
			savedCallsign = `anon${randomNum}`
			localStorage.setItem("callsign", savedCallsign)
		}
		this.currentCallsign = savedCallsign

		initLog("Filling in repeater name")
		document.querySelector("#repeater").addEventListener("change", e => this.setRepeater(e.target.value))
		window.addEventListener("hashchange", () => this.hashchange())
		this.hashchange()

		initLog("Setting up custom room modals")
		this.setupCustomRoomModal()
		this.setupJoinRoomModal()
		this.setupChangeCallsignModal()

		initLog("Setting up chat")
		this.setupChat()

		initLog("Setting up admin password modal")
		this.setupAdminPasswordModal()

		initLog("Setting up enigma callsign modal")
		this.setupEnigmaCallsignModal()

		initLog("Setting up enigma promo link")
		this.setupEnigmaPromoLink()

		initLog("Loading latest enigma solve")
		this.loadLatestSolve()

		initLog("Loading admin callsigns")
		this.loadAdminCallsigns()

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

	BuzzDuration(tx, when, duration, rxTone=69) {
		this.outputs.BuzzDuration(tx, when, duration, rxTone)

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
		this.beginTxTime = Date.now()
		this.outputs.Buzz(true)
		if (this.txChart) this.txChart.Set(1)

		// Show warning if transmitting with break-in off
		if (!this.breakInEnabled && this.breakInField) {
			this.breakInField.classList.add("transmitting-warning")
		}
	}

	/**
	 * Stop the side tone buzzer, and send out how long it was active.
	 *
	 * Called from the keyer
	 */
	EndTx() {
		if (!this.beginTxTime) {
			return
		}
		let endTxTime = Date.now()
		let duration = endTxTime - this.beginTxTime
		this.outputs.Silence(true)

		// Only transmit to the repeater if break-in is enabled
		if (this.breakInEnabled) {
			// Send with current TX tone
			this.repeater.Transmit(this.beginTxTime, duration, true, this.txTone)
		} else if (this.decoder) {
			// If decoder is enabled but break-in is off, still feed to decoder for local decode
			let callsign = localStorage.getItem("callsign") || ""
			this.decoder.addDurations([duration], callsign, this.beginTxTime)
		}

		this.beginTxTime = null
		if (this.txChart) this.txChart.Set(0)

		// Remove warning when transmission ends
		if (this.breakInField) {
			this.breakInField.classList.remove("transmitting-warning")
		}
	}

	/**
	 * Disable break-in due to stuck key detection
	 * Called by the keyer when a key has been held for 10+ seconds
	 */
	DisableBreakInForStuckKey() {
		this.breakInEnabled = false

		// Update the UI toggle
		let breakInToggle = document.querySelector("#break-in-toggle")
		if (breakInToggle) {
			breakInToggle.checked = false
		}

		// Remove warning styling
		if (this.breakInField) {
			this.breakInField.classList.remove("transmitting-warning")
		}

		// Show notification to user
		toast("Stuck key detected! Break-in has been disabled to prevent spam.", 10 * time.Second)
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
	 * Set up the join room modal
	 */
	setupJoinRoomModal() {
		let modal = document.querySelector("#join-room-modal")
		let openBtn = document.querySelector("#join-custom-room-btn")
		let closeBtn = document.querySelector("#close-join-modal-btn")
		let cancelBtn = document.querySelector("#cancel-join-modal-btn")
		let joinBtn = document.querySelector("#join-room-btn")
		let roomNameInput = document.querySelector("#join-room-name")

		// Open modal
		openBtn.addEventListener("click", () => {
			modal.classList.add("is-active")
			roomNameInput.value = ""
			roomNameInput.focus()
		})

		// Close modal
		let closeModal = () => {
			modal.classList.remove("is-active")
		}
		closeBtn.addEventListener("click", closeModal)
		cancelBtn.addEventListener("click", closeModal)
		modal.querySelector(".modal-background").addEventListener("click", closeModal)

		// Join room
		joinBtn.addEventListener("click", () => {
			let roomName = roomNameInput.value.trim()
			if (!roomName) {
				toast("Please enter a room name")
				return
			}
			// No private flag when joining - just connect to existing room
			this.customRoomPrivate = false
			closeModal()
			this.setRepeater(roomName)
		})

		// Allow Enter key to join room
		roomNameInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				joinBtn.click()
			}
		})
	}

	/**
	 * Set up the change callsign modal
	 */
	setupChangeCallsignModal() {
		let modal = document.querySelector("#change-callsign-modal")
		let closeBtn = document.querySelector("#close-callsign-modal-btn")
		let cancelBtn = document.querySelector("#cancel-callsign-modal-btn")
		let saveBtn = document.querySelector("#save-callsign-btn")
		let input = document.querySelector("#new-callsign-input")

		// Close modal
		let closeModal = () => {
			modal.classList.remove("is-active")
		}
		closeBtn.addEventListener("click", closeModal)
		cancelBtn.addEventListener("click", closeModal)
		modal.querySelector(".modal-background").addEventListener("click", closeModal)

		// Save callsign
		saveBtn.addEventListener("click", () => {
			let newCallsign = input.value.trim()
			if (!newCallsign) {
				toast("Please enter a callsign")
				return
			}
			this.setCallsign(newCallsign)
			// Force update of user list to show new callsign
			if (this.repeater && this.repeater.SendCallsign) {
				this.repeater.SendCallsign()
			}
			toast("Callsign changed to: " + newCallsign)
			closeModal()
		})

		// Allow Enter key to save callsign
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				saveBtn.click()
			}
		})
	}

	/**
	 * Set up admin password modal
	 */
	setupAdminPasswordModal() {
		const closeBtn = document.querySelector("#close-admin-password-modal-btn")
		const cancelBtn = document.querySelector("#cancel-admin-password-modal-btn")
		const confirmBtn = document.querySelector("#confirm-admin-password-main-btn")
		const input = document.querySelector("#admin-password-input-main")
		const modal = document.querySelector("#admin-password-modal-main")

		if (!closeBtn || !cancelBtn || !confirmBtn || !input || !modal) {
			return
		}

		const closeModal = () => this.closeAdminPasswordModal()

		closeBtn.addEventListener('click', closeModal)
		cancelBtn.addEventListener('click', closeModal)
		modal.querySelector('.modal-background').addEventListener('click', closeModal)

		const handleSubmit = async () => {
			const password = input.value
			const error = document.querySelector("#admin-password-error-main")

			if (!password) {
				error.style.display = 'block'
				return
			}

			const isValid = await this.verifyAdminPassword(password)

			if (isValid) {
				closeModal()
			} else {
				error.style.display = 'block'
			}
		}

		confirmBtn.addEventListener('click', handleSubmit)

		// Handle form submission
		const form = document.querySelector("#admin-password-form-main")
		if (form) {
			form.addEventListener('submit', (e) => {
				e.preventDefault()
				handleSubmit()
			})
		}

		// Allow Enter key to submit
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				confirmBtn.click()
			}
		})
	}

	/**
	 * Set up chat UI event listeners
	 */
	setupChat() {
		// Setup sidebar chat
		let sendButton = document.querySelector("#chat-send-btn")
		let input = document.querySelector("#chat-input")

		if (sendButton) {
			sendButton.addEventListener("click", () => this.sendChat())
		}

		if (input) {
			// Send on Enter key (but Shift+Enter for new line in future if we use textarea)
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault()
					this.sendChat()
				}
			})
		}

		// Setup inline chat (in tab)
		let sendButtonInline = document.querySelector("#chat-send-btn-inline")
		let inputInline = document.querySelector("#chat-input-inline")

		if (sendButtonInline) {
			sendButtonInline.addEventListener("click", () => this.sendChat(true))
		}

		if (inputInline) {
			inputInline.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault()
					this.sendChat(true)
				}
			})
		}
	}

	/**
	 * Get private rooms from localStorage
	 */
	getPrivateRooms() {
		try {
			let privateRooms = localStorage.getItem("privateRooms")
			return privateRooms ? JSON.parse(privateRooms) : []
		} catch (e) {
			return []
		}
	}

	/**
	 * Save a room as private in localStorage
	 */
	savePrivateRoom(roomName) {
		let privateRooms = this.getPrivateRooms()
		if (!privateRooms.includes(roomName)) {
			privateRooms.push(roomName)
			localStorage.setItem("privateRooms", JSON.stringify(privateRooms))
		}
	}

	/**
	 * Check if a room was created as private by this browser
	 */
	isPrivateRoom(roomName) {
		let privateRooms = this.getPrivateRooms()
		return privateRooms.includes(roomName)
	}

	/**
	 * Get list of rooms with decoder enabled from localStorage
	 */
	getDecoderRooms() {
		try {
			let decoderRooms = localStorage.getItem("decoderRooms")
			return decoderRooms ? JSON.parse(decoderRooms) : []
		} catch (e) {
			return []
		}
	}

	/**
	 * Save a room as having decoder enabled
	 */
	saveDecoderRoom(roomName) {
		let decoderRooms = this.getDecoderRooms()
		if (!decoderRooms.includes(roomName)) {
			decoderRooms.push(roomName)
			localStorage.setItem("decoderRooms", JSON.stringify(decoderRooms))
		}
	}

	/**
	 * Check if a room has decoder enabled
	 */
	isDecoderRoom(roomName) {
		let decoderRooms = this.getDecoderRooms()
		return decoderRooms.includes(roomName)
	}

	/**
	 * Set up the custom room creation modal
	 */
	setupCustomRoomModal() {
		let modal = document.querySelector("#custom-room-modal")
		let openBtn = document.querySelector("#create-custom-room-btn")
		let closeBtn = document.querySelector("#close-modal-btn")
		let cancelBtn = document.querySelector("#cancel-modal-btn")
		let createBtn = document.querySelector("#create-room-btn")
		let roomNameInput = document.querySelector("#custom-room-name")
		let privateCheckbox = document.querySelector("#custom-room-private")
		let decoderCheckbox = document.querySelector("#custom-room-decoder")

		// Open modal
		openBtn.addEventListener("click", () => {
			modal.classList.add("is-active")
			roomNameInput.value = ""
			privateCheckbox.checked = false
			decoderCheckbox.checked = false
			roomNameInput.focus()

			// Auto-check decoder if currently in a decoder room
			if (this.decoder && this.decoder.enabled) {
				decoderCheckbox.checked = true
			}
		})

		// Close modal
		let closeModal = () => {
			modal.classList.remove("is-active")
		}
		closeBtn.addEventListener("click", closeModal)
		cancelBtn.addEventListener("click", closeModal)
		modal.querySelector(".modal-background").addEventListener("click", closeModal)

		// Create room
		createBtn.addEventListener("click", () => {
			let roomName = roomNameInput.value.trim()
			if (!roomName) {
				toast("Please enter a room name")
				return
			}
			if (this.isReservedRoomName(roomName)) {
				toast("This room name is reserved. Please choose a different name.")
				return
			}
			// Store the private flag for the upcoming connection
			this.customRoomPrivate = privateCheckbox.checked
			// Store the decoder flag for the upcoming connection
			this.customRoomDecoder = decoderCheckbox.checked
			// Remember this room as private if checkbox is checked
			if (privateCheckbox.checked) {
				this.savePrivateRoom(roomName)
			}
			// Store decoder preference for this room
			if (decoderCheckbox.checked) {
				this.saveDecoderRoom(roomName)
			}
			closeModal()
			this.setRepeater(roomName)
		})

		// Allow Enter key to create room
		roomNameInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				createBtn.click()
			}
		})
	}

	/**
	 * Set the user's callsign
	 *
	 * @param {string} callsign User's callsign
	 */
	setCallsign(callsign) {
		// Check if admin callsign was entered BEFORE changing it
		if (this.adminCallsigns.some(admin => admin.toUpperCase() === callsign.toUpperCase())) {
			// Store the pending callsign and current one for potential revert
			this.pendingCallsign = callsign
			this.previousCallsign = this.currentCallsign
			this.promptAdminPassword(callsign)
			return // Don't change callsign yet - wait for authentication
		}

		// Regular callsign change (not admin)
		this.currentCallsign = callsign
		localStorage.setItem("callsign", callsign)
		if (this.repeater && this.repeater.SetCallsign) {
			this.repeater.SetCallsign(callsign)
			this.repeater.SendCallsign()
		}
	}

	/**
	 * Prompt for admin password
	 */
	promptAdminPassword(callsign) {
		const modal = document.querySelector("#admin-password-modal-main")
		const input = document.querySelector("#admin-password-input-main")
		const error = document.querySelector("#admin-password-error-main")

		if (!modal || !input || !error) {
			return
		}

		// Update modal text with actual callsign
		const modalBody = modal.querySelector('.modal-card-body p')
		if (modalBody) {
			modalBody.innerHTML = `You've entered the admin callsign <strong>${callsign}</strong>. Please enter your admin password to authenticate.`
		}

		input.value = ''
		error.style.display = 'none'
		modal.classList.add('is-active')

		setTimeout(() => input.focus(), 100)
	}

	/**
	 * Close admin password modal
	 */
	closeAdminPasswordModal() {
		const modal = document.querySelector("#admin-password-modal-main")
		if (modal) {
			modal.classList.remove('is-active')
		}

		// If there's a pending admin callsign change that wasn't authenticated, revert it
		if (this.pendingCallsign && this.previousCallsign) {
			// Revert to previous callsign
			this.currentCallsign = this.previousCallsign
			localStorage.setItem("callsign", this.previousCallsign)
			if (this.repeater && this.repeater.SetCallsign) {
				this.repeater.SetCallsign(this.previousCallsign)
				this.repeater.SendCallsign()
			}

			// Update the UI to show the reverted callsign
			let input = document.querySelector("#new-callsign-input")
			if (input) {
				input.value = this.previousCallsign
			}

			toast("Callsign reverted to: " + this.previousCallsign)
		}

		// Clear pending state
		this.pendingCallsign = null
		this.previousCallsign = null
	}

	/**
	 * Verify admin password
	 */
	async verifyAdminPassword(password) {
		// Use the events API to verify the password
		try {
			const response = await fetch('/api/events', {
				method: 'GET',
				headers: {
					'X-Callsign': this.pendingCallsign || this.currentCallsign,
					'X-Admin-Password': password
				}
			})

			if (response.ok) {
				// Password is correct, store it
				sessionStorage.setItem('admin_password', password)
				sessionStorage.setItem('admin_authenticated', 'true')

				// Now apply the pending callsign change
				if (this.pendingCallsign) {
					this.currentCallsign = this.pendingCallsign
					localStorage.setItem("callsign", this.pendingCallsign)
					if (this.repeater && this.repeater.SetCallsign) {
						this.repeater.SetCallsign(this.pendingCallsign)
						this.repeater.SendCallsign()
					}
					toast("Admin authentication successful! Callsign changed to: " + this.pendingCallsign)
				} else {
					toast("Admin authentication successful!")
				}

				// Clear pending state
				this.pendingCallsign = null
				this.previousCallsign = null

				return true
			} else {
				return false
			}
		} catch (e) {
			console.error("Error verifying admin password:", e)
			return false
		}
	}

	/**
	 * Prompt user to change their callsign
	 */
	promptChangeCallsign() {
		let modal = document.querySelector("#change-callsign-modal")
		let input = document.querySelector("#new-callsign-input")

		// Set current callsign as default value
		input.value = this.currentCallsign

		// Open modal
		modal.classList.add("is-active")

		// Focus input after a short delay to ensure modal is visible
		setTimeout(() => {
			input.focus()
			input.select()
		}, 100)
	}

	/**
	 * Update the user list display
	 *
	 * @param {Array} users List of connected users' callsigns (legacy)
	 * @param {Array} usersInfo List of user objects with callsign and txTone
	 */
	updateUserList(users, usersInfo = []) {
		console.log("updateUserList called with users:", users, "usersInfo:", usersInfo)
		let userListElement = document.querySelector("#user-list")
		if (!userListElement) {
			return
		}

		// Use usersInfo if available, otherwise fall back to users
		let usersList = usersInfo.length > 0 ? usersInfo : users.map(u => ({callsign: u, txTone: 0}))
		console.log("Using usersList:", usersList)

		if (!usersList || usersList.length === 0) {
			userListElement.innerHTML = '<p class="has-text-grey-light is-size-7">No users connected</p>'
			return
		}

		let html = ''
		for (let userInfo of usersList) {
			let user = userInfo.callsign || userInfo
			let txTone = userInfo.txTone || 0
			let isCurrentUser = user === this.currentCallsign

			// Create tooltip text with TX tone info
			let tooltip = ''
			if (txTone > 0) {
				let noteName = Music.MIDINoteName(txTone)
				let freq = Music.MIDINoteFrequency(txTone, 1)
				tooltip = `data-tooltip="TX Tone: ${noteName} (${freq}Hz)"`
			}

			if (isCurrentUser) {
				html += `
					<div class="user-list-item" ${tooltip} style="background-color: rgba(0, 209, 178, 0.15); border-left: 3px solid #00d1b2;">
						<span class="callsign">${user} <strong style="color: #0af;">(You)</strong></span>
						<button class="button is-small is-info" onclick="window.app.promptChangeCallsign()">
							<span class="icon is-small">
								<i class="mdi mdi-pencil"></i>
							</span>
							<span>Change</span>
						</button>
					</div>`
			} else {
				html += `<div class="user-list-item" ${tooltip}><span class="callsign">${user}</span></div>`
			}
		}
		userListElement.innerHTML = html
	}

	/**
	 * Update the rooms list display
	 *
	 * @param {Array} rooms List of active rooms with user counts
	 */
	updateRoomsList(rooms) {
		console.log("updateRoomsList received:", rooms)
		let roomsListElement = document.querySelector("#rooms-list")
		if (!roomsListElement) {
			return
		}

		if (!rooms || rooms.length === 0) {
			roomsListElement.innerHTML = '<p class="has-text-grey-light is-size-7">No active public rooms</p>'
			return
		}

		let html = ''
		for (let room of rooms) {
			let isActive = room.name === this.repeaterName ? 'active' : ''
			let userText = room.users === 1 ? '1 user' : `${room.users} users`
			html += `
				<div class="room-item ${isActive}" data-room="${room.name}">
					<span class="room-name">${room.name || 'General'}</span>
					<span class="room-count">
						<i class="mdi mdi-account-multiple"></i>
						${userText}
					</span>
				</div>
			`
		}
		roomsListElement.innerHTML = html

		// Add click handlers to switch rooms
		for (let roomItem of document.querySelectorAll('.room-item')) {
			roomItem.addEventListener('click', (e) => {
				let roomName = e.currentTarget.dataset.room
				this.setRepeater(roomName)
			})
		}
	}

	/**
	 * Receive a chat message
	 *
	 * @param {string} text The message text
	 * @param {string} callsign The sender's callsign
	 * @param {number} timestamp Message timestamp
	 */
	receiveChat(text, callsign, timestamp) {
		console.log("receiveChat called:", text, callsign, timestamp)

		// Create unique message ID to prevent duplicates
		let messageId = `${timestamp}-${callsign}-${text}`
		if (this.seenMessages.has(messageId)) {
			console.log("Duplicate message detected, skipping:", messageId)
			return
		}
		this.seenMessages.add(messageId)

		let time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		let sender = callsign || "Anonymous"

		// Create message HTML
		let messageHTML = `
			<div class="chat-message-header">
				<span class="chat-sender">${sender}</span>
				<span class="chat-time">${time}</span>
			</div>
			<div class="chat-message-text">${this.escapeHtml(text)}</div>
		`

		// Add to sidebar chat
		let chatMessages = document.querySelector("#chat-messages")
		if (chatMessages) {
			let messageDiv = document.createElement("div")
			messageDiv.classList.add("chat-message")
			messageDiv.innerHTML = messageHTML
			chatMessages.appendChild(messageDiv)
			chatMessages.scrollTop = chatMessages.scrollHeight
		}

		// Add to inline chat (in tab)
		let chatMessagesInline = document.querySelector("#chat-messages-inline")
		if (chatMessagesInline) {
			let messageDivInline = document.createElement("div")
			messageDivInline.classList.add("chat-message")
			messageDivInline.innerHTML = messageHTML
			chatMessagesInline.appendChild(messageDivInline)
			chatMessagesInline.scrollTop = chatMessagesInline.scrollHeight
		}

		// Add notification indicator if text chat tab is not currently visible
		let textChatTab = document.querySelector('[data-tab="text-tab"]')
		let textChatTabContent = document.querySelector('#text-tab')
		if (textChatTab && textChatTabContent && textChatTabContent.style.display === 'none') {
			textChatTab.classList.add('has-notification')
		}

		console.log("Message added to chat areas")
	}

	/**
	 * Escape HTML to prevent XSS
	 */
	escapeHtml(text) {
		let div = document.createElement('div')
		div.textContent = text
		return div.innerHTML
	}

	/**
	 * Send a chat message
	 * @param {boolean} isInline True if sending from inline chat (in tab)
	 */
	sendChat(isInline = false) {
		console.log("sendChat() called, isInline:", isInline)

		// Determine which input to use
		let inputId = isInline ? "#chat-input-inline" : "#chat-input"
		let input = document.querySelector(inputId)

		if (!input) {
			console.error("Chat input not found:", inputId)
			return
		}

		let text = input.value.trim()
		console.log("Chat text:", text)
		if (!text) {
			return
		}

		console.log("Repeater:", this.repeater)
		console.log("SendChat method exists:", this.repeater && this.repeater.SendChat)

		if (this.repeater && this.repeater.SendChat) {
			console.log("Calling repeater.SendChat()")
			this.repeater.SendChat(text)
			input.value = ""

			// Also clear the other input if it has the same text
			let otherInputId = isInline ? "#chat-input" : "#chat-input-inline"
			let otherInput = document.querySelector(otherInputId)
			if (otherInput && otherInput.value.trim() === text) {
				otherInput.value = ""
			}
		} else {
			console.error("Repeater or SendChat not available")
			this.error("Not connected to a repeater")
		}
	}

	/**
	 * Check if a room name is a default room
	 */
	isDefaultRoom(name) {
		const defaultRooms = ["General", "", "1", "2", "3", "Channel 1", "Channel 2", "Channel 3",
		                     "Null", "Echo", "Decoder", "Fortunes", "Fortunes: Pauses ×2", "Fortunes: Pauses ×4", "Fortunes: Pauses ×8"]
		return defaultRooms.includes(name)
	}

	/**
	 * Check if a room name is reserved (case-insensitive exact match)
	 */
	isReservedRoomName(name) {
		const reserved = [
			"", "1", "2", "3",  // internal values
			"general", "channel 1", "channel 2", "channel 3",
			"null", "echo", "decoder",
			"fortunes", "fortunes: pauses ×2", "fortunes: pauses ×4", "fortunes: pauses ×8"
		]
		return reserved.includes(name.toLowerCase().trim())
	}

	/**
	 * Update dropdown to show custom room
	 */
	updateDropdownForCustomRoom(name, isPrivate) {
		let repeaterElement = document.querySelector("#repeater")

		// Remove any existing custom room options
		let customOptions = repeaterElement.querySelectorAll('option[data-custom="true"]')
		customOptions.forEach(opt => opt.remove())

		// If it's a custom room, add it to the dropdown
		if (!this.isDefaultRoom(name)) {
			let displayName = name + (isPrivate ? " - Private" : "")
			let option = document.createElement("option")
			option.value = name
			option.textContent = displayName
			option.setAttribute("data-custom", "true")
			option.selected = true
			repeaterElement.insertBefore(option, repeaterElement.firstChild)
		}
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
		if (!name || (name == "")) {
			name = DefaultRepeater
		}
		this.repeaterName = name

		// Check if this room was created as private in localStorage
		// This handles the case when refreshing or loading from URL
		if (!this.customRoomPrivate && this.isPrivateRoom(name)) {
			this.customRoomPrivate = true
		}

		// Check if this room has decoder enabled in localStorage
		if (!this.customRoomDecoder && this.isDecoderRoom(name)) {
			this.customRoomDecoder = true
		}

		// Track if we created this as a private room
		this.currentRoomIsPrivate = this.customRoomPrivate || false

		// Update dropdown for custom rooms
		this.updateDropdownForCustomRoom(name, this.currentRoomIsPrivate)

		// Set value of repeater element
		let repeaterElement = document.querySelector("#repeater")
		let paps = repeaterElement.parentElement
		// Map DefaultRepeater ("General") back to empty string for the dropdown
		let dropdownValue = (name === DefaultRepeater) ? "" : name
		if (paps.MaterialTextfield) {
			paps.MaterialTextfield.change(dropdownValue)
		} else {
			repeaterElement.value = dropdownValue
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

		if (name == "Weekly Enigma") {
			// Load puzzle data and create Enigma repeater
			let chatCallback = (text, callsign, timestamp) => this.receiveChat(text, callsign, timestamp)
			this.loadEnigmaPuzzle().then(puzzleData => {
				this.currentEnigmaPuzzle = puzzleData
				this.repeater = new Repeaters.Enigma(rx, chatCallback, this.roboKeyer, puzzleData)
				// Set callsign on the repeater
				let callsign = localStorage.getItem("callsign") || ""
				if (this.repeater.SetCallsign) {
					this.repeater.SetCallsign(callsign)
				}
				if (this.repeater.SetTxTone) {
					this.repeater.SetTxTone(this.txTone)
				}
				// Start the enigma loop after connection is established
				setTimeout(() => {
					if (this.repeater.startEnigmaLoop) {
						this.repeater.startEnigmaLoop()
					}
				}, 1000)
				this.showEnigmaTab(puzzleData)
			})
			this.disableDecoder()
			this.hideEnigmaTab() // Hide until puzzle loads
			return // Early return since we handle repeater setup in the promise
		} else if (name.startsWith("Fortunes")) {
			this.roboKeyer.SetPauseMultiplier(number || 1)
			this.repeater = new Repeaters.Fortune(rx, this.roboKeyer)
		} else if (name.startsWith("Echo")) {
			this.repeater = new Repeaters.Echo(rx)
		} else if (name == "Null") {
			this.repeater = new Repeaters.Null(rx)
		} else {
			// Pass the private flag, decoder flag, and chat callback to the Vail constructor
			let chatCallback = (text, callsign, timestamp) => this.receiveChat(text, callsign, timestamp)
			let isDecoder = name == "Decoder" || this.customRoomDecoder || false
			this.repeater = new Repeaters.Vail(rx, name, this.customRoomPrivate || false, isDecoder, chatCallback)

			// Enable decoder for "Decoder" room or custom rooms with decoder enabled
			if (isDecoder) {
				this.enableDecoder()
			} else {
				this.disableDecoder()
			}
		}

		// Hide Enigma tab when not in Weekly Enigma room
		if (name != "Weekly Enigma") {
			this.hideEnigmaTab()
		}

		// Clear chat messages when switching rooms
		let chatMessages = document.querySelector("#chat-messages")
		if (chatMessages) {
			chatMessages.innerHTML = ''
		}
		let chatMessagesInline = document.querySelector("#chat-messages-inline")
		if (chatMessagesInline) {
			chatMessagesInline.innerHTML = ''
		}
		// Clear seen messages tracker when switching rooms
		this.seenMessages.clear()

		// Clear the flags after use
		this.customRoomPrivate = false
		this.customRoomDecoder = false

		// Set callsign and TX tone on new repeater
		let callsign = localStorage.getItem("callsign") || ""
		if (this.repeater.SetCallsign) {
			this.repeater.SetCallsign(callsign)
		}
		console.log("Setting TX tone on new repeater connection:", this.txTone)
		if (this.repeater.SetTxTone) {
			this.repeater.SetTxTone(this.txTone)
		}
	}

	/**
	 * Enable the morse code decoder and show the active decoder display
	 */
	enableDecoder() {
		// Create decoder instance if it doesn't exist
		if (!this.decoder) {
			this.decoder = new VailDecoder(
				(text, callsign, timestamp) => this.displayDecodedText(text, callsign, timestamp),
				20  // Initial WPM estimate
			)
		} else {
			this.decoder.setEnabled(true)
		}

		// Show the active decoder display, hide the disabled message
		let activeDisplay = document.querySelector("#decoder-active-display")
		let disabledMessage = document.querySelector("#decoder-disabled-message")
		if (activeDisplay) {
			activeDisplay.style.display = ""
		}
		if (disabledMessage) {
			disabledMessage.style.display = "none"
		}

		// Set up decoder UI event handlers
		let clearBtn = document.querySelector("#decoder-clear-btn")
		if (clearBtn && !clearBtn._decoderInitialized) {
			clearBtn.addEventListener("click", () => this.clearDecodedText())
			clearBtn._decoderInitialized = true
		}
	}

	/**
	 * Disable the morse code decoder and show the informational message
	 */
	disableDecoder() {
		// Disable decoder if it exists
		if (this.decoder) {
			this.decoder.setEnabled(false)
		}

		// Show the disabled message, hide the active display
		let activeDisplay = document.querySelector("#decoder-active-display")
		let disabledMessage = document.querySelector("#decoder-disabled-message")
		if (activeDisplay) {
			activeDisplay.style.display = "none"
		}
		if (disabledMessage) {
			disabledMessage.style.display = ""
		}
	}

	/**
	 * Display decoded morse code text in the UI
	 */
	displayDecodedText(text, callsign, timestamp) {
		let display = document.querySelector("#decoded-text-display")
		if (!display) {
			return
		}

		// Remove the placeholder text if it exists
		let placeholder = display.querySelector(".has-text-grey-light")
		if (placeholder) {
			placeholder.remove()
		}

		// Get or create the continuous text stream
		let textStream = display.querySelector("#decoded-text-stream")
		if (!textStream) {
			textStream = document.createElement("p")
			textStream.id = "decoded-text-stream"
			textStream.style.marginBottom = "0"
			textStream.style.wordWrap = "break-word"
			textStream.style.whiteSpace = "pre-wrap"
			display.appendChild(textStream)
		}

		// Append the new text to the stream
		textStream.textContent += text

		// Auto-scroll to bottom
		display.parentElement.parentElement.scrollTop = display.parentElement.parentElement.scrollHeight

		// Update speed display if decoder is available
		if (this.decoder) {
			let speed = this.decoder.getSpeed()
			let speedDisplay = document.querySelector("#decoder-speed-display")
			if (speedDisplay) {
				speedDisplay.textContent = `Speed: ${speed.wpm.toFixed(1)} WPM`
			}
		}
	}

	/**
	 * Clear all decoded text from the display
	 */
	clearDecodedText() {
		let display = document.querySelector("#decoded-text-display")
		if (display) {
			display.innerHTML = '<p class="has-text-grey-light">Decoded morse code will appear here...</p>'
		}

		// Reset the decoder
		if (this.decoder) {
			this.decoder.reset()
		}
	}

	/**
	 * Load the current Enigma puzzle from the server
	 */
	async loadEnigmaPuzzle() {
		try {
			const response = await fetch('/api/enigma')
			if (!response.ok) {
				throw new Error('Failed to load puzzle')
			}
			const data = await response.json()
			if (data.error) {
				console.warn('No Enigma puzzle available:', data.error)
				return null
			}
			return data
		} catch (e) {
			console.error('Error loading enigma puzzle:', e)
			return null
		}
	}

	/**
	 * Show the Enigma tab and populate with puzzle settings
	 */
	showEnigmaTab(puzzleData) {
		// Show the Enigma tab button
		let tabButton = document.querySelector('#enigma-tab-button')
		if (tabButton) {
			tabButton.style.display = ''
		}

		// Hide Morse Chat and Decode tabs (not relevant for Enigma room)
		let morseChatTab = document.querySelector('li[data-tab="morse-tab"]')
		let decodeTab = document.querySelector('#decoder-tab-button')
		if (morseChatTab) morseChatTab.style.display = 'none'
		if (decodeTab) decodeTab.style.display = 'none'

		// Disable break-in toggle (transmission not allowed in Enigma room)
		let breakInToggle = document.querySelector('#break-in-toggle')
		let breakInField = document.querySelector('#break-in-field')
		if (breakInToggle) {
			breakInToggle.disabled = true
			breakInToggle.checked = false
		}
		if (breakInField) {
			breakInField.style.opacity = '0.5'
			breakInField.style.pointerEvents = 'none'
			breakInField.title = 'Break-in is disabled in the Weekly Enigma room'
		}

		// Auto-select the Enigma tab
		const tabs = document.querySelectorAll('.tabs li[data-tab]')
		tabs.forEach(t => t.classList.remove('is-active'))
		if (tabButton) tabButton.classList.add('is-active')
		document.querySelectorAll('.tab-content').forEach(content => {
			content.style.display = 'none'
		})
		let enigmaTabContent = document.querySelector('#enigma-tab')
		if (enigmaTabContent) enigmaTabContent.style.display = 'block'

		// Show/hide appropriate content
		let noPuzzle = document.querySelector('#enigma-no-puzzle')
		let settingsBox = document.querySelector('#enigma-settings')?.parentElement
		let answerBox = document.querySelector('#enigma-answer-input')?.parentElement?.parentElement?.parentElement

		if (!puzzleData || !puzzleData.settings) {
			// No puzzle available
			if (noPuzzle) noPuzzle.style.display = ''
			if (settingsBox) settingsBox.style.display = 'none'
			if (answerBox) answerBox.style.display = 'none'
			return
		}

		// Puzzle available - show settings
		if (noPuzzle) noPuzzle.style.display = 'none'
		if (settingsBox) settingsBox.style.display = ''
		if (answerBox) answerBox.style.display = ''

		// Populate settings
		const settings = puzzleData.settings
		document.querySelector('#enigma-rotors').textContent =
			(settings.rotors || []).join(' - ') || '--'
		document.querySelector('#enigma-positions').textContent =
			(settings.rotorPositions || []).join(' - ') || '--'
		document.querySelector('#enigma-rings').textContent =
			(settings.ringSettings || []).join(' - ') || '--'
		document.querySelector('#enigma-reflector').textContent =
			settings.reflector || '--'
		document.querySelector('#enigma-plugboard').textContent =
			settings.plugboard || 'None'

		// Set up answer submission handler
		this.setupEnigmaAnswerHandler()

		// Load leaderboard
		this.loadEnigmaLeaderboard()

		// Set up leaderboard toggle
		this.setupEnigmaLeaderboardToggle()
	}

	/**
	 * Hide the Enigma tab and restore normal UI state
	 */
	hideEnigmaTab() {
		let tabButton = document.querySelector('#enigma-tab-button')
		if (tabButton) {
			tabButton.style.display = 'none'
		}

		// Restore Morse Chat and Decode tabs visibility
		let morseChatTab = document.querySelector('li[data-tab="morse-tab"]')
		let decodeTab = document.querySelector('#decoder-tab-button')
		if (morseChatTab) morseChatTab.style.display = ''
		if (decodeTab) decodeTab.style.display = ''

		// Re-enable break-in toggle
		let breakInToggle = document.querySelector('#break-in-toggle')
		let breakInField = document.querySelector('#break-in-field')
		if (breakInToggle) {
			breakInToggle.disabled = false
		}
		if (breakInField) {
			breakInField.style.opacity = ''
			breakInField.style.pointerEvents = ''
			breakInField.title = ''
		}

		// Switch to Morse Chat tab if currently on Enigma tab
		let enigmaTabContent = document.querySelector('#enigma-tab')
		if (enigmaTabContent && enigmaTabContent.style.display !== 'none') {
			const tabs = document.querySelectorAll('.tabs li[data-tab]')
			tabs.forEach(t => t.classList.remove('is-active'))
			if (morseChatTab) morseChatTab.classList.add('is-active')
			document.querySelectorAll('.tab-content').forEach(content => {
				content.style.display = 'none'
			})
			let morseTabContent = document.querySelector('#morse-tab')
			if (morseTabContent) morseTabContent.style.display = 'block'
		}
	}

	/**
	 * Load admin callsigns from server
	 */
	async loadAdminCallsigns() {
		try {
			const response = await fetch('/api/admin-callsigns')
			if (response.ok) {
				this.adminCallsigns = await response.json()
				// Now that we have the list, check if current user is admin
				this.checkAndShowAdminLink()
			}
		} catch (e) {
			console.error('Error loading admin callsigns:', e)
		}
	}

	/**
	 * Check if current user is an admin and show the admin link
	 */
	checkAndShowAdminLink() {
		const callsign = (localStorage.getItem('callsign') || '').toUpperCase()
		const isAdmin = this.adminCallsigns.some(admin => admin.toUpperCase() === callsign)

		const adminLink = document.querySelector('#enigma-admin-link')
		if (adminLink && isAdmin) {
			adminLink.style.display = ''
		}
	}

	/**
	 * Set up the Enigma answer submission handler
	 */
	setupEnigmaAnswerHandler() {
		let submitBtn = document.querySelector('#enigma-submit-btn')
		let inputField = document.querySelector('#enigma-answer-input')
		let resultDiv = document.querySelector('#enigma-result')

		if (submitBtn && !submitBtn._enigmaInitialized) {
			submitBtn._enigmaInitialized = true

			const checkAnswer = async () => {
				const answer = inputField.value.trim()
				if (!answer) return

				const callsign = localStorage.getItem('callsign') || ''

				try {
					const response = await fetch('/api/enigma/check', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'X-Callsign': callsign
						},
						body: JSON.stringify({ answer, callsign })
					})
					const data = await response.json()

					resultDiv.style.display = ''
					if (data.correct) {
						if (data.alreadySolved) {
							resultDiv.innerHTML = '<div class="notification is-success"><strong>Correct!</strong> You\'ve already solved this week\'s puzzle.</div>'
						} else if (data.isAnonymous) {
							// Show callsign prompt modal
							resultDiv.innerHTML = '<div class="notification is-success"><strong>Correct!</strong></div>'
							this.showEnigmaCallsignModal()
						} else if (data.recorded) {
							resultDiv.innerHTML = '<div class="notification is-success"><strong>Congratulations!</strong> You decoded the message correctly! Your solve has been recorded on the leaderboard.</div>'
							// Refresh leaderboard
							this.loadEnigmaLeaderboard()
							// Refresh latest solve in promo box
							this.loadLatestSolve()
						} else {
							resultDiv.innerHTML = '<div class="notification is-success"><strong>Congratulations!</strong> You decoded the message correctly!</div>'
						}
					} else {
						resultDiv.innerHTML = '<div class="notification is-danger is-light">Incorrect. Keep trying!</div>'
						// Clear the incorrect message after a few seconds
						setTimeout(() => {
							resultDiv.style.display = 'none'
						}, 3000)
					}
				} catch (e) {
					console.error('Error checking answer:', e)
					resultDiv.innerHTML = '<div class="notification is-warning">Error checking answer. Please try again.</div>'
					resultDiv.style.display = ''
				}
			}

			submitBtn.addEventListener('click', checkAnswer)
			inputField.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					checkAnswer()
				}
			})
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
		this.clockOffset = stats.clockOffset || "?"
		let now = Date.now()
		when += this.rxDelay

		// Check if decoder setting from server differs from current state
		// Only for non-special rooms (not Decoder, Echo, Fortunes, Null)
		if (stats.decoder !== undefined && !this.repeaterName.startsWith("Echo") &&
		    !this.repeaterName.startsWith("Fortunes") && this.repeaterName != "Null") {
			let shouldBeEnabled = this.repeaterName == "Decoder" || stats.decoder
			let isEnabled = this.decoder && this.decoder.enabled

			if (shouldBeEnabled && !isEnabled) {
				console.log("Server says decoder should be enabled, enabling decoder")
				this.enableDecoder()
			} else if (!shouldBeEnabled && isEnabled) {
				console.log("Server says decoder should be disabled, disabling decoder")
				this.disableDecoder()
			}
		}

		if (duration > 0) {
			if (when < now) {
				console.warn("Too old", when, duration)
				this.error("Packet requested playback " + (now - when) + "ms in the past. Increase receive delay!")
				return
			}

			// Extract sender's TX tone from stats, default to A4 (69) if not provided
			let rxTone = stats.txTone || 69
			this.BuzzDuration(false, when, duration, rxTone)

			this.rxDurations.unshift(duration)
			this.rxDurations.splice(20, 2)
		}

		// Feed durations to decoder if enabled and available
		if (this.decoder && stats.durations && stats.durations.length > 0) {
			this.decoder.addDurations(stats.durations, stats.callsign, stats.messageTimestamp)
		}

		if (stats.notice) {
			toast(stats.notice)
		}

		let averageLag = (stats.averageLag || 0).toFixed(2)
		let longestRxDuration = this.rxDurations.reduce((a,b) => Math.max(a,b))
		let suggestedDelay = ((averageLag + longestRxDuration) * 1.2).toFixed(0)

		if (stats.connected !== undefined) {
			this.outputs.SetConnected(stats.connected)
		}

		// Update user list (use detailed usersInfo if available)
		if (stats.users || stats.usersInfo) {
			this.updateUserList(stats.users, stats.usersInfo)
		}

		// Update rooms list
		if (stats.rooms) {
			this.updateRoomsList(stats.rooms)

			// Check if current room is in the public rooms list
			// If not, and it's a custom room, it must be private
			if (this.repeaterName && !this.isDefaultRoom(this.repeaterName)) {
				let foundInPublicList = stats.rooms.some(room => room.name === this.repeaterName)
				if (!foundInPublicList && !this.currentRoomIsPrivate) {
					// Room is not in public list, so it must be private
					this.currentRoomIsPrivate = true
					this.updateDropdownForCustomRoom(this.repeaterName, true)
				}
			}
		}

		this.updateReading("#note", stats.note || stats.clients || "😎")
		this.updateReading("#lag-value", averageLag)
		this.updateReading("#longest-rx-value", longestRxDuration)
		this.updateReading("#suggested-delay-value", suggestedDelay)
		this.updateReading("#clock-off-value", this.clockOffset)
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

	/**
	 * Load and display the Enigma leaderboard
	 */
	async loadEnigmaLeaderboard() {
		try {
			const response = await fetch('/api/enigma/leaderboard')
			if (!response.ok) {
				throw new Error('Failed to load leaderboard')
			}
			const leaderboard = await response.json()
			this.displayLeaderboard(leaderboard)
		} catch (e) {
			console.error('Error loading leaderboard:', e)
			let content = document.querySelector('#enigma-leaderboard-content')
			if (content) {
				content.innerHTML = '<p class="has-text-grey-light is-size-7">Unable to load leaderboard</p>'
			}
		}
	}

	/**
	 * Display the leaderboard in the UI
	 */
	displayLeaderboard(leaderboard) {
		let content = document.querySelector('#enigma-leaderboard-content')
		if (!content) return

		if (!leaderboard || leaderboard.length === 0) {
			content.innerHTML = '<p class="has-text-grey-light is-size-7">No solves yet. Be the first!</p>'
			return
		}

		// Store full leaderboard for "Show all" functionality
		this.fullLeaderboard = leaderboard

		let html = '<table class="table is-fullwidth is-narrow" style="background-color: transparent;">'
		html += '<thead><tr>'
		html += '<th style="color: #b5b5b5; border-bottom: 1px solid #363636; width: 40px;">#</th>'
		html += '<th style="color: #b5b5b5; border-bottom: 1px solid #363636;">Callsign</th>'
		html += '<th style="color: #b5b5b5; border-bottom: 1px solid #363636; text-align: right;">Solves</th>'
		html += '</tr></thead><tbody>'

		const displayCount = this.showAllLeaderboard ? leaderboard.length : Math.min(10, leaderboard.length)

		for (let i = 0; i < displayCount; i++) {
			const entry = leaderboard[i]
			let medal = ''
			if (i === 0) medal = '<span class="icon has-text-warning"><i class="mdi mdi-medal"></i></span>'
			else if (i === 1) medal = '<span class="icon" style="color: #c0c0c0;"><i class="mdi mdi-medal"></i></span>'
			else if (i === 2) medal = '<span class="icon" style="color: #cd7f32;"><i class="mdi mdi-medal"></i></span>'

			html += `<tr>`
			html += `<td style="color: #e8e8e8; border-bottom: 1px solid #2a2a2a;">${medal || (i + 1)}</td>`
			html += `<td style="color: #e8e8e8; border-bottom: 1px solid #2a2a2a;">${this.escapeHtml(entry.callsign)}</td>`
			html += `<td style="color: #e8e8e8; border-bottom: 1px solid #2a2a2a; text-align: right;">${entry.totalSolves}</td>`
			html += `</tr>`
		}

		html += '</tbody></table>'

		if (leaderboard.length > 10) {
			if (this.showAllLeaderboard) {
				html += `<p class="is-size-7 has-text-grey-light mt-2" style="text-align: center;">
					<a href="#" id="enigma-show-less-btn" style="color: #c9f;">Show less</a>
				</p>`
			} else {
				html += `<p class="is-size-7 has-text-grey-light mt-2" style="text-align: center;">
					Showing top 10 of ${leaderboard.length} participants -
					<a href="#" id="enigma-show-all-btn" style="color: #c9f;">Show all</a>
				</p>`
			}
		}

		content.innerHTML = html

		// Set up show all/less buttons
		const showAllBtn = document.querySelector('#enigma-show-all-btn')
		if (showAllBtn) {
			showAllBtn.addEventListener('click', (e) => {
				e.preventDefault()
				this.showAllLeaderboard = true
				this.displayLeaderboard(this.fullLeaderboard)
			})
		}

		const showLessBtn = document.querySelector('#enigma-show-less-btn')
		if (showLessBtn) {
			showLessBtn.addEventListener('click', (e) => {
				e.preventDefault()
				this.showAllLeaderboard = false
				this.displayLeaderboard(this.fullLeaderboard)
			})
		}
	}

	/**
	 * Set up leaderboard toggle (collapse/expand)
	 */
	setupEnigmaLeaderboardToggle() {
		const header = document.querySelector('#enigma-leaderboard-header')
		const content = document.querySelector('#enigma-leaderboard-content')
		const toggleIcon = document.querySelector('#enigma-leaderboard-toggle i')

		if (header && !header._toggleInitialized) {
			header._toggleInitialized = true
			header.addEventListener('click', () => {
				if (content.style.display === 'none') {
					content.style.display = ''
					if (toggleIcon) toggleIcon.className = 'mdi mdi-chevron-up'
				} else {
					content.style.display = 'none'
					if (toggleIcon) toggleIcon.className = 'mdi mdi-chevron-down'
				}
			})
		}
	}

	/**
	 * Escape HTML to prevent XSS
	 */
	escapeHtml(text) {
		const div = document.createElement('div')
		div.textContent = text
		return div.innerHTML
	}

	/**
	 * Load the latest solve for the promo box
	 */
	async loadLatestSolve() {
		try {
			const response = await fetch('/api/enigma/latest-solve')
			if (!response.ok) {
				throw new Error('Failed to load latest solve')
			}
			const solve = await response.json()
			this.updateEnigmaPromoBox(solve)
		} catch (e) {
			console.error('Error loading latest solve:', e)
		}
	}

	/**
	 * Update the Enigma promo box with latest solve info
	 */
	updateEnigmaPromoBox(solve) {
		const container = document.querySelector('#enigma-latest-solve')
		const textEl = document.querySelector('#enigma-latest-solve-text')

		if (!container || !textEl) return

		if (!solve || !solve.callsign) {
			container.style.display = 'none'
			return
		}

		// Format the date
		const date = new Date(solve.solvedAt)
		const dateStr = date.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		})
		const timeStr = date.toLocaleTimeString(undefined, {
			hour: 'numeric',
			minute: '2-digit'
		})

		textEl.textContent = `Last decoded by ${solve.callsign} on ${dateStr} at ${timeStr}`
		container.style.display = ''
	}

	/**
	 * Set up the Enigma callsign prompt modal
	 */
	setupEnigmaCallsignModal() {
		let modal = document.querySelector("#enigma-callsign-modal")
		let closeBtn = document.querySelector("#close-enigma-callsign-modal-btn")
		let saveBtn = document.querySelector("#save-enigma-callsign-btn")
		let skipBtn = document.querySelector("#skip-enigma-callsign-btn")
		let input = document.querySelector("#enigma-callsign-input")

		if (!modal) return

		let closeModal = () => {
			modal.classList.remove("is-active")
		}

		if (closeBtn) closeBtn.addEventListener("click", closeModal)
		if (skipBtn) skipBtn.addEventListener("click", closeModal)
		modal.querySelector(".modal-background")?.addEventListener("click", closeModal)

		if (saveBtn) {
			saveBtn.addEventListener("click", async () => {
				let newCallsign = input.value.trim()
				if (!newCallsign) {
					toast("Please enter a callsign")
					return
				}

				// Check if still anonymous-style
				if (newCallsign.toLowerCase().startsWith('anon')) {
					toast("Please choose a non-anonymous callsign")
					return
				}

				// Update callsign
				this.setCallsign(newCallsign)

				// Re-submit the answer with new callsign to record
				const answer = document.querySelector('#enigma-answer-input').value.trim()
				try {
					const response = await fetch('/api/enigma/check', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'X-Callsign': newCallsign
						},
						body: JSON.stringify({ answer, callsign: newCallsign })
					})
					const data = await response.json()

					if (data.recorded) {
						toast("Your solve has been recorded!")
						this.loadEnigmaLeaderboard()
						this.loadLatestSolve()

						// Update the result div
						let resultDiv = document.querySelector('#enigma-result')
						if (resultDiv) {
							resultDiv.innerHTML = '<div class="notification is-success"><strong>Congratulations!</strong> You decoded the message correctly! Your solve has been recorded on the leaderboard.</div>'
						}
					}
				} catch (e) {
					console.error('Error recording solve:', e)
				}

				closeModal()
			})
		}

		if (input) {
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					saveBtn?.click()
				}
			})
		}
	}

	/**
	 * Show the Enigma callsign modal
	 */
	showEnigmaCallsignModal() {
		let modal = document.querySelector("#enigma-callsign-modal")
		let input = document.querySelector("#enigma-callsign-input")
		if (modal) {
			if (input) input.value = ''
			modal.classList.add("is-active")
			if (input) input.focus()
		}
	}

	/**
	 * Set up the Enigma promo box link
	 */
	setupEnigmaPromoLink() {
		const link = document.querySelector('#enigma-promo-link')
		if (link) {
			link.addEventListener('click', (e) => {
				e.preventDefault()
				// Find the room selector and switch to Weekly Enigma
				const roomSelect = document.querySelector('#repeater')
				if (roomSelect) {
					// Find the Weekly Enigma option
					for (let option of roomSelect.options) {
						if (option.value === 'Weekly Enigma') {
							roomSelect.value = option.value
							roomSelect.dispatchEvent(new Event('change'))
							break
						}
					}
				}
			})
		}
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
