package main

import (
	"bytes"
	"encoding/binary"
	"time"
)

// MessageSender can send Messages
type MessageSender interface {
	Send(m Message) error
}

// MessageReceiver can receive Messages
type MessageReceiver interface {
	Receive() (Message, error)
}

// MessageSocket can send and receive Messages
type MessageSocket interface {
	MessageSender
	MessageReceiver
}

// Message is a single Vail message.
type Message struct {
	// Timestamp of this message. Milliseconds since epoch.
	Timestamp int64

	// Number of connected clients.
	Clients uint16

	// Message timing in milliseconds.
	// Timings alternate between tone and silence.
	// For example, `A` could be sent as [80, 80, 240]
	Duration []uint16

	// Sender's callsign (optional)
	Callsign string `json:",omitempty"`

	// Sender's TX tone as MIDI note number (0-127, 0 means not specified)
	TxTone uint8 `json:",omitempty"`

	// List of connected users with callsigns in current repeater (sent on join/part/status updates)
	Users []string `json:",omitempty"`

	// List of connected users with detailed info (callsign + TX tone)
	UsersInfo []UserInfo `json:",omitempty"`

	// List of all active rooms with user counts (sent periodically)
	Rooms []RoomInfo `json:",omitempty"`

	// Whether this room is private (won't appear in room lists)
	Private bool `json:",omitempty"`

	// Whether this room has the decoder enabled
	Decoder bool `json:",omitempty"`

	// Text chat message (optional, for chat messages)
	Text string `json:",omitempty"`
}

// RoomInfo contains information about a repeater room
type RoomInfo struct {
	Name    string `json:"name"`
	Users   int    `json:"users"`
	Private bool   `json:"private"`
}

// UserInfo contains information about a connected user
type UserInfo struct {
	Callsign string `json:"callsign"`
	TxTone   uint8  `json:"txTone"` // MIDI note number
}

func NewMessage(ts time.Time, durations ...time.Duration) Message {
	msg := Message{
		Timestamp: ts.UnixNano() / time.Millisecond.Nanoseconds(),
		Duration:  make([]uint16, len(durations)),
	}
	for i, dns := range durations {
		ms := dns.Milliseconds()
		if ms > 255 {
			ms = 255
		} else if ms < 0 {
			ms = 0
		}
		msg.Duration[i] = uint16(ms)
	}
	return msg
}

// Marshaling presumes something else is keeping track of lengths
func (m Message) MarshalBinary() ([]byte, error) {
	var w bytes.Buffer
	if err := binary.Write(&w, binary.BigEndian, m.Timestamp); err != nil {
		return nil, err
	}
	if err := binary.Write(&w, binary.BigEndian, m.Clients); err != nil {
		return nil, err
	}
	if err := binary.Write(&w, binary.BigEndian, m.Duration); err != nil {
		return nil, err
	}
	return w.Bytes(), nil
}

// UnmarshalBinary unpacks a binary buffer into a Message.
func (m *Message) UnmarshalBinary(data []byte) error {
	r := bytes.NewReader(data)
	if err := binary.Read(r, binary.BigEndian, &m.Timestamp); err != nil {
		return err
	}
	if err := binary.Read(r, binary.BigEndian, &m.Clients); err != nil {
		return err
	}
	dlen := r.Len() / 2
	m.Duration = make([]uint16, dlen)
	if err := binary.Read(r, binary.BigEndian, &m.Duration); err != nil {
		return err
	}
	return nil
}

func (m Message) Equal(m2 Message) bool {
	if m.Timestamp != m2.Timestamp {
		return false
	}

	if len(m.Duration) != len(m2.Duration) {
		return false
	}

	for i := range m.Duration {
		if m.Duration[i] != m2.Duration[i] {
			return false
		}
	}

	return true
}
