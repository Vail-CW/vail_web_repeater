package main

import (
	"log"
	"time"
)

// Client represents a connected user
type Client struct {
	sender   MessageSender
	callsign string
	txTone   uint8 // MIDI note number for this client's TX tone (0-127)
}

// A Repeater is just a list of clients.
type Repeater struct {
	clock        Clock
	clients      []*Client
	private      bool
	decoder      bool      // Whether decoder is enabled for this room
	chatHistory  []Message // Ring buffer for recent chat messages
	lastActivity time.Time // Last time this room had activity
}

// NewRepeater returns a newly-created repeater
func NewRepeater() *Repeater {
	return &Repeater{
		clock:        WallClock{},
		clients:      make([]*Client, 0, 20),
		private:      false,
		chatHistory:  make([]Message, 0, 50), // Keep last 50 messages
		lastActivity: time.Now(),
	}
}

// SetPrivate sets the private status of this repeater
func (r *Repeater) SetPrivate(private bool) {
	r.private = private
}

// IsPrivate returns whether this repeater is private
func (r *Repeater) IsPrivate() bool {
	return r.private
}

// SetDecoder sets the decoder status of this repeater
func (r *Repeater) SetDecoder(decoder bool) {
	r.decoder = decoder
}

// IsDecoder returns whether this repeater has the decoder enabled
func (r *Repeater) IsDecoder() bool {
	return r.decoder
}

// Join joins a writer to this repeater with an optional callsign and TX tone
func (r *Repeater) Join(sender MessageSender, callsign string, txTone uint8) {
	client := &Client{
		sender:   sender,
		callsign: callsign,
		txTone:   txTone,
	}
	r.clients = append(r.clients, client)

	// Send chat history to the new client
	for _, chatMsg := range r.chatHistory {
		sender.Send(chatMsg)
	}

	r.SendMessage()
}

// Part removes a writer from this repeater
func (r *Repeater) Part(sender MessageSender) {
	for i, c := range r.clients {
		if c.sender == sender {
			nsubs := len(r.clients)
			r.clients[i] = r.clients[nsubs-1]
			r.clients = r.clients[:nsubs-1]
		}
	}
	r.SendMessage()
}

// UpdateCallsign updates the callsign for an existing client
func (r *Repeater) UpdateCallsign(sender MessageSender, callsign string) {
	for _, c := range r.clients {
		if c.sender == sender {
			c.callsign = callsign
			r.SendMessage()
			return
		}
	}
}

// UpdateTxTone updates the TX tone for an existing client
func (r *Repeater) UpdateTxTone(sender MessageSender, txTone uint8) {
	for _, c := range r.clients {
		if c.sender == sender {
			c.txTone = txTone
			r.SendMessage() // Broadcast update to all clients
			return
		}
	}
}

// GetClientTxTone returns the TX tone for a given sender, or 0 if not found
func (r *Repeater) GetClientTxTone(sender MessageSender) uint8 {
	for _, c := range r.clients {
		if c.sender == sender {
			return c.txTone
		}
	}
	return 0 // Default tone if not found
}

// GetCallsign returns the callsign for a given sender, or empty string if not found
func (r *Repeater) GetCallsign(sender MessageSender) string {
	for _, c := range r.clients {
		if c.sender == sender {
			return c.callsign
		}
	}
	return ""
}

// HasCallsign checks if a callsign is already present in the room
// Used to prevent duplicate Discord join notifications during reconnections
func (r *Repeater) HasCallsign(callsign string) bool {
	if callsign == "" {
		return false
	}
	for _, c := range r.clients {
		if c.callsign == callsign {
			return true
		}
	}
	return false
}

// GetUserList returns a list of callsigns for connected users
func (r *Repeater) GetUserList() []string {
	users := make([]string, 0, len(r.clients))
	for _, c := range r.clients {
		if c.callsign != "" && !isHiddenCallsign(c.callsign) {
			users = append(users, c.callsign)
		}
	}
	return users
}

// GetUsersInfo returns detailed info (callsign + TX tone) for connected users
func (r *Repeater) GetUsersInfo() []UserInfo {
	users := make([]UserInfo, 0, len(r.clients))
	log.Printf("GetUsersInfo: %d clients total\n", len(r.clients))
	for _, c := range r.clients {
		log.Printf("  Client: callsign='%s', txTone=%d\n", c.callsign, c.txTone)
		if c.callsign != "" && !isHiddenCallsign(c.callsign) {
			users = append(users, UserInfo{
				Callsign: c.callsign,
				TxTone:   c.txTone,
			})
		}
	}
	log.Printf("GetUsersInfo returning %d users: %+v\n", len(users), users)
	return users
}

// Send send a message to all connected clients
func (r *Repeater) Send(m Message) {
	m.Clients = uint16(r.VisibleListeners())
	m.Users = r.GetUserList()
	m.UsersInfo = r.GetUsersInfo() // Include detailed user info with TX tones
	m.Decoder = r.decoder          // Include decoder setting for this room

	// Check if this is a chat message (has Text but no Duration)
	if m.Text != "" && len(m.Duration) == 0 {
		// Add to chat history
		r.AddChatMessage(m)
	}

	// Send to all clients, logging errors but continuing to others
	for _, c := range r.clients {
		err := c.sender.Send(m)
		if err != nil {
			// Log but don't crash - client will be cleaned up by their handler
			log.Printf("Failed to send to client (callsign: %s): %v\n", c.callsign, err)
		}
	}
}

// SendMessage constructs and sends a message
func (r *Repeater) SendMessage(durations ...time.Duration) {
	m := NewMessage(r.clock.Now(), durations...)
	r.Send(m)
}

// Listeners returns the number of connected clients.
//
// This is the raw connection count and intentionally includes hidden
// (monitoring) clients. It drives room lifecycle (stale cleanup), so a room
// with only a monitor connected must NOT be considered empty — otherwise the
// room entry could be deleted while the monitor's socket is still attached.
func (r *Repeater) Listeners() int {
	return len(r.clients)
}

// VisibleListeners returns the number of connected clients excluding hidden
// (monitoring) clients. This is the count shown to other users and in the
// public room list, so automated monitors don't appear as participants.
func (r *Repeater) VisibleListeners() int {
	count := 0
	for _, c := range r.clients {
		if !isHiddenCallsign(c.callsign) {
			count++
		}
	}
	return count
}

// AddChatMessage adds a chat message to the history buffer
func (r *Repeater) AddChatMessage(m Message) {
	// Add to history
	r.chatHistory = append(r.chatHistory, m)

	// Keep only last 50 messages (ring buffer)
	if len(r.chatHistory) > 50 {
		r.chatHistory = r.chatHistory[len(r.chatHistory)-50:]
	}
}

// GetChatHistory returns recent chat messages
func (r *Repeater) GetChatHistory() []Message {
	return r.chatHistory
}

// UpdateActivity updates the last activity time to now
func (r *Repeater) UpdateActivity() {
	r.lastActivity = r.clock.Now()
}

// IsStale returns true if the room is empty and hasn't had activity for 15+ minutes
func (r *Repeater) IsStale() bool {
	if r.Listeners() > 0 {
		return false
	}
	staleThreshold := 15 * time.Minute
	return r.clock.Now().Sub(r.lastActivity) > staleThreshold
}
