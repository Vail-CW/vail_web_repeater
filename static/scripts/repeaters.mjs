import {GetFortune} from "./fortunes.mjs"
import * as time from "./time.mjs"

/**
 * Compare two messages
 * 
 * @param {Object} m1 First message
 * @param {Object} m2 Second message
 * @returns {Boolean} true if messages are equal
 */
function MessageEqual(m1, m2) {
    if ((m1.Timestamp != m2.Timestamp) || (m1.Duration.length != m2.Duration.length)) {
        return false
    }
    for (let i=0; i < m1.Duration.length; i++) {
        if (m1.Duration[i] != m2.Duration[i]) {
            return false
        }
    }
    return true    
}

export class Vail {
    constructor(rx, name, isPrivate = false, isDecoder = false, chatCallback = null) {
        this.rx = rx
        this.chatCallback = chatCallback
        this.name = name
        this.lagDurations = []
        this.sent = []
        this.wantConnected = true
        this.connected = false
        this.callsign = ""
        this.txTone = 72 // Default TX tone (C5)
        this.privateRoom = isPrivate
        this.decoderRoom = isDecoder
        this.keepaliveInterval = null
        this.disconnectedDueToInactivity = false

		this.wsUrl = new URL("chat", window.location)
		this.wsUrl.protocol = this.wsUrl.protocol.replace("http", "ws")
        this.wsUrl.pathname = this.wsUrl.pathname.replace("testing/", "") // Allow staging deploys
        this.wsUrl.searchParams.set("repeater", name)

        this.reopen()
    }

    SetCallsign(callsign) {
        this.callsign = callsign
    }

    SetTxTone(txTone) {
        this.txTone = txTone
        // Send update to server
        this.SendCallsign()
    }

    reopen() {
        if (!this.wantConnected) {
            return
        }
        this.rx(0, 0, {connected: false})
        console.info("Attempting to reconnect", this.wsUrl.href)
        this.clockOffset = 0
		this.socket = new WebSocket(this.wsUrl, ["json.vailmorse.com"])
		this.socket.addEventListener("message", e => this.wsMessage(e))
        this.socket.addEventListener(
            "open",
            msg => {
                this.connected = true
                this.disconnectedDueToInactivity = false // Clear inactivity flag on successful connection
                this.rx(0, 0, {connected: true, notice: "Repeater connected"})
                // Send initial message with callsign
                this.SendCallsign()
                // Start keepalive to prevent connection timeout (send every 15 seconds)
                // Aggressive keepalive prevents Cloud Run and load balancer timeouts
                this.keepaliveInterval = setInterval(() => this.SendCallsign(), 15 * time.Second)
            }
        )
		this.socket.addEventListener(
            "close",
            msg => {
                // Clear keepalive interval
                if (this.keepaliveInterval) {
                    clearInterval(this.keepaliveInterval)
                    this.keepaliveInterval = null
                }

                // Check if disconnected due to inactivity
                if (msg.reason && msg.reason.includes("inactivity")) {
                    this.disconnectedDueToInactivity = true
                    this.wantConnected = false
                    this.rx(0, 0, {connected: false, notice: `Disconnected due to inactivity. Send morse or chat to reconnect.`})
                    console.info("Disconnected due to inactivity. Will reconnect on next activity.")
                } else {
                    this.rx(0, 0, {connected: false, notice: `Repeater disconnected: ${msg.reason}`})
                    console.error("Repeater connection dropped:", msg.reason)
                    setTimeout(() => this.reopen(), 2*time.Second)
                }
            }
        )
    }

    SendCallsign() {
        if (this.socket.readyState != 1) {
            return
        }
        let msg = {
            Timestamp: Date.now(),
            Duration: [],
            Callsign: this.callsign,
            TxTone: this.txTone,
            Private: this.privateRoom,
            Decoder: this.decoderRoom
        }
        console.log("SendCallsign - Room:", this.name, "Private:", this.privateRoom, "Decoder:", this.decoderRoom, "TxTone:", this.txTone, "Message:", msg)
        this.socket.send(JSON.stringify(msg))
    }

    wsMessage(event) {
        let now = Date.now()
        let jmsg = event.data
        let msg
        try {
            msg = JSON.parse(jmsg)
        }
        catch (err) {
            console.error(err, jmsg)
            return
        }
        // Debug logging to see what we're receiving
        console.log("wsMessage received:", {
            TxTone: msg.TxTone,
            UsersInfo: msg.UsersInfo,
            Users: msg.Users,
            Duration: msg.Duration
        })
        let stats = {
            averageLag: this.lagDurations.reduce((a,b) => (a+b), 0) / this.lagDurations.length,
            clockOffset: this.clockOffset,
            clients: msg.Clients,
            connected: this.connected,
            users: msg.Users || [],
            usersInfo: msg.UsersInfo || [], // Detailed user info with TX tones
            txTone: msg.TxTone || 0, // Include sender's TX tone
            decoder: msg.Decoder || false, // Include decoder setting for this room
        }
        // Only include rooms if actually present (not empty)
        if (msg.Rooms && msg.Rooms.length > 0) {
            stats.rooms = msg.Rooms
        }

        // Check if this is a chat message (has Text field)
        if (msg.Text) {
            console.log("Received chat message:", msg.Text, "from:", msg.Callsign)
            if (this.chatCallback) {
                console.log("Calling chatCallback")
                this.chatCallback(msg.Text, msg.Callsign, msg.Timestamp)
            } else {
                console.error("No chatCallback registered!")
            }
        }

		// XXX: Why is this happening?
		if (msg.Timestamp == 0) {
            console.debug("Got timestamp=0", msg)
			return
        }
        
        let sent = this.sent.filter(m => !MessageEqual(msg, m))
		if (sent.length < this.sent.length) {
			// We're getting our own message back, which tells us our lag.
			// We shouldn't emit a tone, though.
			let totalDuration = msg.Duration.reduce((a, b) => a + b)
            this.sent = sent
            this.lagDurations.unshift(now - this.clockOffset - msg.Timestamp - totalDuration)
            this.lagDurations.splice(20, 2)

            // Still pass durations to decoder for our own transmissions
            let adjustedTxTime = msg.Timestamp + this.clockOffset
            stats.durations = msg.Duration
            stats.callsign = msg.Callsign || ""
            stats.messageTimestamp = adjustedTxTime

            this.rx(0, 0, stats)
			return
		}

        // Packets with 0 length tell us what time the server thinks it is,
        // and how many clients are connected
		if (msg.Duration.length == 0) {
            this.clockOffset = now - msg.Timestamp
            this.rx(0, 0, stats)
			return
		}

		// Adjust playback time to clock offset
        let adjustedTxTime = msg.Timestamp + this.clockOffset

		// Add Duration array, callsign, and timestamp to stats for decoder
		stats.durations = msg.Duration
		stats.callsign = msg.Callsign || ""
		stats.messageTimestamp = adjustedTxTime  // Use adjusted time for decoder timing

		// Every second value is a silence duration
		let tx = true
		for (let duration of msg.Duration) {
			duration = Number(duration)
			if (tx && (duration > 0)) {
                this.rx(adjustedTxTime, duration, stats)
			}
			adjustedTxTime = Number(adjustedTxTime) + duration
			tx = !tx
		}
    }

    /**
     * Send a transmission
     *
     * @param {number} timestamp When to play this transmission
     * @param {number} duration How long the transmission is
     * @param {boolean} squelch True to mute this tone when we get it back from the repeater
     * @param {number} txTone MIDI note for TX tone (optional, will be set by VailClient)
     */
    Transmit(timestamp, duration, squelch=true, txTone=0) {
        // Reconnect if disconnected due to inactivity
        if (this.disconnectedDueToInactivity) {
            this.disconnectedDueToInactivity = false
            this.wantConnected = true
            this.reopen()
            console.info("Reconnecting due to user activity (morse transmission)")
        }

        let msg = {
            Timestamp: timestamp - this.clockOffset,
            Duration: [duration],
        }
        if (txTone > 0) {
            msg.TxTone = txTone
        }
        let jmsg = JSON.stringify(msg)

        if (this.socket.readyState != 1) {
            // If we aren't connected, complain.
            console.error("Not connected, dropping", jmsg)
            return
        }
        this.socket.send(jmsg)
        if (squelch) {
            this.sent.push(msg)
        }
    }

    /**
     * Send a chat message
     *
     * @param {string} text The chat message text
     */
    SendChat(text) {
        console.log("SendChat called with:", text)
        if (!text || text.trim() === "") {
            return
        }

        // Reconnect if disconnected due to inactivity
        if (this.disconnectedDueToInactivity) {
            this.disconnectedDueToInactivity = false
            this.wantConnected = true
            this.reopen()
            console.info("Reconnecting due to user activity (chat message)")
            // Wait a bit for connection to establish, then send
            setTimeout(() => this.SendChat(text), 1000)
            return
        }

        let msg = {
            Timestamp: Date.now() - this.clockOffset,
            Duration: [],
            Text: text,
            Callsign: this.callsign,
        }
        let jmsg = JSON.stringify(msg)
        console.log("Sending chat message:", jmsg)
        console.log("Socket readyState:", this.socket.readyState, "Expected: 1 (OPEN)")

        if (this.socket.readyState != 1) {
            console.error("Not connected, cannot send chat. Socket state:", this.socket.readyState)
            return
        }
        console.log("Socket is OPEN, sending via WebSocket")
        this.socket.send(jmsg)
        console.log("Message sent!")
    }

    Close() {
        this.wantConnected = false
        if (this.keepaliveInterval) {
            clearInterval(this.keepaliveInterval)
            this.keepaliveInterval = null
        }
        this.socket.close()
    }
}

export class Null {
    constructor(rx, interval=3*time.Second) {
        this.rx = rx
        this.init()
    }

    notice(msg) {
        this.rx(0, 0, {connected: false, notice: msg})
    }

    init() {
        this.notice("Null repeater: nobody will hear you.")
    }

    Transmit(time, duration, squelch=true) {}

    Close() {}
}

export class Echo extends Null {
    constructor(rx, delay=0) {
        super(rx)
        this.delay = delay
    }

    init () {
        this.notice("Echo repeater: you can only hear yourself.")
    }

    Transmit(time, duration, squelch=true) {
        this.rx(time + this.delay, duration, {note: "local"})
    }
}

export class Fortune extends Null {
    /**
     *
     * @param rx Receive callback
     * @param {Keyer} keyer Robokeyer
     */
    constructor(rx, keyer) {
        super(rx)
        this.keyer = keyer
    }

    init() {
        this.notice("Say something, and I will tell you your fortune.")
    }

    pulse() {
        this.timeout = null
        if (!this.keyer || this.keyer.Busy()) {
            return
        }

        let fortune = GetFortune()
        this.keyer.EnqueueAsciiString(`${fortune} \x04    `)
    }

    Transmit(time, duration, squelch=true) {
        if (this.timeout) {
            clearTimeout(this.timeout)
        }
        this.timeout = setTimeout(() => this.pulse(), 3 * time.Second)
    }

    Close() {
        this.keyer.Flush()
        super.Close()
    }
}

/**
 * Weekly Enigma repeater
 *
 * Connects to server for user list and text chat, but morse transmission is disabled.
 * Plays a looping encoded message locally at 15 WPM with 5 second pause between loops.
 */
export class Enigma extends Vail {
    /**
     * @param rx Receive callback
     * @param {Function} chatCallback Chat message callback
     * @param {Keyer} keyer Robokeyer for local morse playback
     * @param {Object} puzzleData The enigma puzzle data
     */
    constructor(rx, chatCallback, keyer, puzzleData) {
        // Connect to server for user list + text chat
        super(rx, "Weekly Enigma", false, false, chatCallback)
        this.keyer = keyer
        this.puzzleData = puzzleData
        this.loopTimer = null
        this.ENIGMA_WPM = 15  // Fixed playback speed for Enigma messages
        this.PAUSE_BETWEEN_MS = 5000  // 5 second pause between transmissions
    }

    /**
     * Called after connection is established
     */
    startEnigmaLoop() {
        if (!this.puzzleData?.encodedMessage) {
            this.rx(0, 0, {notice: "Weekly Enigma: No puzzle available yet."})
            return
        }
        this.rx(0, 0, {notice: "Weekly Enigma: Decode the message using the Enigma settings shown in the Enigma tab."})
        // Start the first play immediately
        this.playMessage()
    }

    /**
     * Play the encoded message using the robokeyer
     */
    playMessage() {
        if (!this.puzzleData?.encodedMessage || !this.keyer) {
            return
        }

        // Wait if keyer is still busy
        if (this.keyer.Busy()) {
            this.loopTimer = setTimeout(() => this.playMessage(), 100)
            return
        }

        // Set to Enigma playback speed
        const ditDuration = Math.round(1200 / this.ENIGMA_WPM)  // 80ms per dit at 15 WPM
        this.keyer.SetDitDuration(ditDuration)

        // Play the encoded message with end-of-transmission marker (SK prosign)
        this.keyer.EnqueueAsciiString(this.puzzleData.encodedMessage + " \x04")

        // Start polling for when keyer finishes
        this.waitForFinish()
    }

    /**
     * Poll until keyer is done, then wait 5 seconds and play again
     */
    waitForFinish() {
        if (this.keyer.Busy()) {
            // Still playing, check again in 200ms
            this.loopTimer = setTimeout(() => this.waitForFinish(), 200)
        } else {
            // Done playing - now wait 5 seconds before next loop
            this.loopTimer = setTimeout(() => this.playMessage(), this.PAUSE_BETWEEN_MS)
        }
    }

    /**
     * Override Transmit to do nothing (disable morse TX in this room)
     */
    Transmit(timestamp, duration, squelch=true, txTone=0) {
        // Intentionally empty - no morse transmission allowed in Enigma room
    }

    /**
     * Clean up when leaving the room
     */
    Close() {
        if (this.loopTimer) {
            clearTimeout(this.loopTimer)
            this.loopTimer = null
        }
        if (this.keyer) {
            this.keyer.Flush()
        }
        super.Close()
    }
}
