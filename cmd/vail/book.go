package main

import (
	"log"
	"time"
)

// RecentDeparture tracks users who recently left a room (for reconnection detection)
type RecentDeparture struct {
	callsign  string
	roomName  string
	leftAt    time.Time
}

// Book maps names to repeaters
//
// It ensures that names map 1-1 to repeaters.
type Book struct {
	entries           map[string]*Repeater
	events            chan bookEvent
	makeRepeater      func() *Repeater
	lastBroadcast     time.Time
	broadcastPending  bool
	recentDepartures  []RecentDeparture // Track recent departures for reconnection detection
}

func NewBook() *Book {
	return &Book{
		entries:          make(map[string]*Repeater),
		events:           make(chan bookEvent, 5),
		makeRepeater:     NewRepeater,
		lastBroadcast:    time.Time{}, // Zero time
		broadcastPending: false,
		recentDepartures: make([]RecentDeparture, 0, 100),
	}
}

type bookEventType int

const (
	joinEvent = bookEventType(iota)
	partEvent
	sendEvent
	updateCallsignEvent
	updateTxToneEvent
)

type bookEvent struct {
	eventType bookEventType
	name      string
	sender    MessageSender
	callsign  string
	txTone    uint8
	m         Message
	private   bool
	decoder   bool
}

// Join adds a writer to a named repeater with a callsign, private flag, decoder flag, and TX tone
func (b *Book) Join(name string, sender MessageSender, callsign string, private bool, decoder bool, txTone uint8) {
	b.events <- bookEvent{
		eventType: joinEvent,
		name:      name,
		sender:    sender,
		callsign:  callsign,
		private:   private,
		decoder:   decoder,
		txTone:    txTone,
	}
}

// Part removes a writer from a named repeater
func (b *Book) Part(name string, sender MessageSender) {
	b.events <- bookEvent{
		eventType: partEvent,
		name:      name,
		sender:    sender,
	}
}

// Send transmits a message to the named repeater
func (b *Book) Send(name string, m Message) {
	b.events <- bookEvent{
		eventType: sendEvent,
		name:      name,
		m:         m,
	}
}

// UpdateCallsign updates a user's callsign in the named repeater
func (b *Book) UpdateCallsign(name string, sender MessageSender, callsign string) {
	b.events <- bookEvent{
		eventType: updateCallsignEvent,
		name:      name,
		sender:    sender,
		callsign:  callsign,
	}
}

// UpdateTxTone updates a user's TX tone in the named repeater
func (b *Book) UpdateTxTone(name string, sender MessageSender, txTone uint8) {
	b.events <- bookEvent{
		eventType: updateTxToneEvent,
		name:      name,
		sender:    sender,
		txTone:    txTone,
	}
}

// GetRooms returns information about all active public repeater rooms (excludes private rooms and empty rooms)
func (b *Book) GetRooms() []RoomInfo {
	rooms := make([]RoomInfo, 0, len(b.entries))
	for name, repeater := range b.entries {
		isPrivate := repeater.IsPrivate()
		userCount := repeater.Listeners()
		log.Printf("GetRooms: Room '%s' IsPrivate=%v, Users=%d\n", name, isPrivate, userCount)
		if !isPrivate && userCount > 0 {
			rooms = append(rooms, RoomInfo{
				Name:    name,
				Users:   userCount,
				Private: false,
			})
		}
	}
	log.Printf("GetRooms: Returning %d public rooms\n", len(rooms))
	return rooms
}

// broadcastRoomList sends room list update to all active repeaters
// Rate limited to once every 2 seconds to prevent message floods
func (b *Book) broadcastRoomList() {
	now := time.Now()

	// If we broadcasted within the last 2 seconds, mark as pending and return
	if now.Sub(b.lastBroadcast) < 2*time.Second {
		b.broadcastPending = true
		return
	}

	// Perform the broadcast
	b.lastBroadcast = now
	b.broadcastPending = false

	roomList := b.GetRooms()
	timestamp := now.UnixMilli()
	for _, repeater := range b.entries {
		// Create a fresh message for each repeater
		msg := Message{
			Timestamp: timestamp,
			Duration:  []uint16{},
			Rooms:     roomList,
		}
		repeater.Send(msg)
	}
}

// processPendingBroadcast checks if a broadcast is pending and sends it
func (b *Book) processPendingBroadcast() {
	if b.broadcastPending && time.Now().Sub(b.lastBroadcast) >= 2*time.Second {
		b.broadcastRoomList()
	}
}

// addRecentDeparture tracks a user who recently left a room
func (b *Book) addRecentDeparture(callsign, roomName string) {
	b.recentDepartures = append(b.recentDepartures, RecentDeparture{
		callsign: callsign,
		roomName: roomName,
		leftAt:   time.Now(),
	})
	// Keep only last 100 departures
	if len(b.recentDepartures) > 100 {
		b.recentDepartures = b.recentDepartures[len(b.recentDepartures)-100:]
	}
}

// wasRecentDeparture checks if a user recently left this room (within 30 seconds)
// This helps detect quick reconnections that should not trigger Discord notifications
func (b *Book) wasRecentDeparture(callsign, roomName string) bool {
	cutoff := time.Now().Add(-30 * time.Second)
	for i := len(b.recentDepartures) - 1; i >= 0; i-- {
		dep := b.recentDepartures[i]
		if dep.leftAt.Before(cutoff) {
			// Clean up old departures while we're here
			b.recentDepartures = b.recentDepartures[i+1:]
			break
		}
		if dep.callsign == callsign && dep.roomName == roomName {
			return true
		}
	}
	return false
}

// hasPendingLeave checks if Discord has a pending leave update for this user+room
// Returns true if the user has a leave timer scheduled (grace period active)
func (b *Book) hasPendingLeave(callsign, roomName string) bool {
	// This is checked via the Discord webhook's message tracking
	// We'll call a new function in discord.go to check this
	return HasPendingLeave(roomName, callsign)
}

// Run is the endless run loop
func (b *Book) Run() {
	// Ticker to check for pending broadcasts every second
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			// Check if we need to send a pending broadcast
			b.processPendingBroadcast()
		case event := <-b.events:
			b.handleEvent(event)
		}
	}
}

func (b *Book) handleEvent(event bookEvent) {
	repeater, ok := b.entries[event.name]

	switch event.eventType {
	case joinEvent:
		// Detect reconnection scenarios:
		// 1. User already in room (same WebSocket dropped and reconnected instantly)
		// 2. User recently left (within 30 seconds) - network hiccup or page refresh
		// 3. User has pending leave timer - graceful disconnect/reconnect
		isReconnect := false
		reconnectReason := ""

		if event.callsign != "" {
			// Check if already in room
			if ok && repeater.HasCallsign(event.callsign) {
				isReconnect = true
				reconnectReason = "already in room"
			} else if b.wasRecentDeparture(event.callsign, event.name) {
				// Check if recently left (within 30 seconds)
				isReconnect = true
				reconnectReason = "recent departure"
			} else if b.hasPendingLeave(event.callsign, event.name) {
				// Check if Discord has a pending leave timer
				isReconnect = true
				reconnectReason = "pending leave timer"
			}
		}

		if !ok {
			repeater = b.makeRepeater()
			repeater.SetPrivate(event.private)
			repeater.SetDecoder(event.decoder)
			b.entries[event.name] = repeater
			log.Printf("Created new room '%s' with private=%v, decoder=%v\n", event.name, event.private, event.decoder)
		}
		repeater.Join(event.sender, event.callsign, event.txTone)
		repeater.UpdateActivity() // Update activity time
		log.Printf("Room '%s' IsPrivate=%v, Listeners=%d\n", event.name, repeater.IsPrivate(), repeater.Listeners())

		// Send Discord notification for public rooms
		// Skip if this is a reconnection
		if !repeater.IsPrivate() && event.callsign != "" && !isReconnect {
			NotifyUserJoined(event.name, event.callsign)
			log.Printf("Discord: NEW join for %s in %s\n", event.callsign, event.name)
		} else if isReconnect {
			log.Printf("Discord: RECONNECT detected for %s in %s (%s - no notification sent)\n", event.callsign, event.name, reconnectReason)
		}

		// Broadcast room list update to all rooms (rate limited)
		b.broadcastRoomList()
	case partEvent:
		if !ok {
			log.Println("WARN: Parting an empty channel:", event.name)
			break
		}
		// Get callsign before removing the client
		callsign := repeater.GetCallsign(event.sender)
		isPrivate := repeater.IsPrivate()

		repeater.Part(event.sender)

		// Track this departure for reconnection detection
		if callsign != "" {
			b.addRecentDeparture(callsign, event.name)
		}

		// Send Discord notification for public rooms
		if !isPrivate && callsign != "" {
			NotifyUserLeft(event.name, callsign)
		}

		// Don't delete empty rooms immediately - let cleanup goroutine handle it
		// Broadcast room list update to all rooms (rate limited)
		b.broadcastRoomList()
	case sendEvent:
		if !ok {
			log.Println("WARN: Sending to an empty channel:", event.name)
			break
		}
		repeater.UpdateActivity() // Update activity time
		repeater.Send(event.m)
	case updateCallsignEvent:
		if !ok {
			log.Println("WARN: Updating callsign in an empty channel:", event.name)
			break
		}
		repeater.UpdateCallsign(event.sender, event.callsign)
		// Broadcast room list update to all rooms (rate limited)
		b.broadcastRoomList()
	case updateTxToneEvent:
		if !ok {
			log.Println("WARN: Updating TX tone in an empty channel:", event.name)
			break
		}
		repeater.UpdateTxTone(event.sender, event.txTone)
	}
}

// CleanupStaleRooms removes rooms that are empty and inactive for 15+ minutes
func (b *Book) CleanupStaleRooms() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		for name, repeater := range b.entries {
			if repeater.IsStale() {
				delete(b.entries, name)
				log.Printf("Cleaned up stale room '%s'\n", name)
			}
		}
	}
}
