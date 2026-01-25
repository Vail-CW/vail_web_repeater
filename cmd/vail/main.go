package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/coder/websocket"
)

var book *Book

const JsonProtocol = "json.vailmorse.com"
const BinaryProtocol = "binary.vailmorse.com"
const InactivityTimeout = 30 * time.Minute

// Clock defines an interface for getting the current time.
//
// We use this in testing to provide a fixed value for the current time, so we
// can still compare clocks.
type Clock interface {
	Now() time.Time
}

// WallClock is a Clock which provides the actual time
type WallClock struct{}

func (WallClock) Now() time.Time {
	return time.Now()
}

// VailWebSocketConnection reads and writes Message structs
type VailWebSocketConnection struct {
	*websocket.Conn
	usingJSON bool
}

func (c *VailWebSocketConnection) Receive() (Message, error) {
	var m Message
	messageType, buf, err := c.Read(context.Background())
	if err != nil {
		return m, err
	}

	if messageType == websocket.MessageText {
		err = json.Unmarshal(buf, &m)
	} else {
		err = m.UnmarshalBinary(buf)
	}
	return m, err
}

func (c *VailWebSocketConnection) Send(m Message) error {
	var err error
	var buf []byte
	var messageType websocket.MessageType

	if c.usingJSON {
		messageType = websocket.MessageText
		buf, err = json.Marshal(m)
	} else {
		messageType = websocket.MessageBinary
		buf, err = m.MarshalBinary()
	}
	if err != nil {
		return err
	}

	// Add 5 second write timeout to prevent blocking on slow clients
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	return c.Write(ctx, messageType, buf)
}

func ChatHandler(w http.ResponseWriter, r *http.Request) {
	forwardedFor := r.Header.Get("X-Forwarded-For")
	client := fmt.Sprintf("<%s|%s>", forwardedFor, r.RemoteAddr)

	// Set up websocket
	ws, err := websocket.Accept(
		w, r,
		&websocket.AcceptOptions{
			Subprotocols: []string{JsonProtocol, BinaryProtocol},
		},
	)
	if err != nil {
		log.Println(err)
		return
	}
	defer ws.Close(websocket.StatusInternalError, "Internal error")

	// Create our Vail websocket connection for books to send to
	sock := VailWebSocketConnection{
		Conn: ws,
	}

	// websockets apparently sends a subprotocol string, so we can ignore Accept headers!
	switch ws.Subprotocol() {
	case JsonProtocol:
		sock.usingJSON = true
	case BinaryProtocol:
		sock.usingJSON = false
	default:
		ws.Close(websocket.StatusPolicyViolation, "client must speak a vail protocol")
		return
	}

	// Join the repeater
	repeaterName := r.FormValue("repeater")
	callsign := ""
	private := false
	decoder := false

	// Read first message to get callsign, private flag, decoder flag, and TX tone
	m, err := sock.Receive()
	if err != nil {
		ws.Close(websocket.StatusInvalidFramePayloadData, err.Error())
		return
	}
	if m.Callsign != "" {
		callsign = m.Callsign
	}
	if m.Private {
		private = true
	}
	if m.Decoder {
		decoder = true
	}
	txTone := m.TxTone // Track the client's TX tone

	log.Printf("%s %s received first message: Private=%v, Decoder=%v, Callsign=%s, TxTone=%d\n", client, repeaterName, m.Private, m.Decoder, m.Callsign, m.TxTone)

	// Join with initial TX tone
	book.Join(repeaterName, &sock, callsign, private, decoder, txTone)
	defer book.Part(repeaterName, &sock)

	log.Println(client, repeaterName, "connect", "private:", private, "txTone:", txTone)

	// Track activity for inactivity timeout
	lastActivityTime := time.Now()
	connectionDone := make(chan bool)
	defer close(connectionDone)

	// Start inactivity checker goroutine
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				timeSinceLastActivity := time.Since(lastActivityTime)
				if timeSinceLastActivity > InactivityTimeout {
					log.Printf("%s %s disconnecting due to inactivity (%v)\n", client, repeaterName, timeSinceLastActivity)
					ws.Close(websocket.StatusGoingAway, "Disconnected due to inactivity")
					return
				}
			case <-connectionDone:
				return
			}
		}
	}()

	for {
		// Read a packet
		m, err := sock.Receive()
		if err != nil {
			ws.Close(websocket.StatusInvalidFramePayloadData, err.Error())
			break
		}

		// Update callsign if provided (clients send empty Duration messages with callsign on connect)
		if m.Callsign != "" && m.Callsign != callsign {
			callsign = m.Callsign
			book.UpdateCallsign(repeaterName, &sock, callsign)
			log.Println(client, repeaterName, "callsign:", callsign)
		}

		// Update TX tone if provided
		if m.TxTone != 0 && m.TxTone != txTone {
			txTone = m.TxTone
			book.UpdateTxTone(repeaterName, &sock, txTone)
			log.Println(client, repeaterName, "txTone:", txTone)
		}

		// Update activity time for ALL messages (including keepalives)
		// This prevents inactivity timeout even when user is just listening
		lastActivityTime = time.Now()

		// If it's empty and not a chat message, skip it (but we already updated activity time)
		if len(m.Duration) == 0 && m.Text == "" {
			continue
		}

		// If it's wildly out of time, reject it
		timeDelta := time.Duration(time.Now().UnixMilli()-m.Timestamp) * time.Millisecond
		if timeDelta < 0 {
			timeDelta = -timeDelta
		}
		if timeDelta > 10*time.Second {
			log.Println(err)
			ws.Close(websocket.StatusInvalidFramePayloadData, "Your clock is off by too much")
			break
		}

		// Ensure the message has the sender's TX tone for forwarding
		// Use stored txTone if message doesn't have one
		if m.TxTone == 0 {
			m.TxTone = txTone
		}

		book.Send(repeaterName, m)
	}

	log.Println(client, repeaterName, "disconnect")
}

func main() {
	book = NewBook()

	// Initialize Discord webhook
	InitDiscordWebhook()

	// Initialize event store with Firestore (optional for testing)
	projectID := os.Getenv("GCP_PROJECT")
	if projectID != "" {
		ctx := context.Background()
		var err error
		eventStore, err = NewEventStore(ctx, projectID)
		if err != nil {
			log.Printf("Warning: Failed to initialize event store: %v (continuing without it)\n", err)
			eventStore = nil
		} else {
			defer eventStore.Close()
			log.Println("Event store initialized successfully")

			// Initialize enigma store using the same Firestore client
			enigmaStore = NewEnigmaStore(eventStore.client)
			log.Println("Enigma store initialized successfully")
		}
	} else {
		log.Println("GCP_PROJECT not set - running without event store (admin features disabled)")
	}

	// Register handlers
	http.Handle("/chat", http.HandlerFunc(ChatHandler))
	http.Handle("/api/events", http.HandlerFunc(GetEventsHandler))
	http.Handle("/api/events/create", http.HandlerFunc(CreateEventHandler))
	http.Handle("/api/events/update", http.HandlerFunc(UpdateEventHandler))
	http.Handle("/api/events/delete", http.HandlerFunc(DeleteEventHandler))
	http.Handle("/api/events/export", http.HandlerFunc(ExportEventsHandler))
	http.Handle("/api/events/import", http.HandlerFunc(ImportEventsHandler))
	http.Handle("/api/enigma", http.HandlerFunc(GetEnigmaHandler))
	http.Handle("/api/enigma/full", http.HandlerFunc(GetEnigmaFullHandler))
	http.Handle("/api/enigma/update", http.HandlerFunc(UpdateEnigmaHandler))
	http.Handle("/api/enigma/check", http.HandlerFunc(CheckEnigmaAnswerHandler))
	http.Handle("/api/enigma/leaderboard", http.HandlerFunc(GetEnigmaLeaderboardHandler))
	http.Handle("/api/enigma/latest-solve", http.HandlerFunc(GetLatestSolveHandler))
	http.Handle("/api/admin-callsigns", http.HandlerFunc(GetAdminCallsignsHandler))
	http.Handle("/", http.FileServer(http.Dir("static")))

	go book.Run()
	go book.CleanupStaleRooms()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Println("Listening on port", port)

	// Log admin configuration
	adminCallsignsEnv := os.Getenv("ADMIN_CALLSIGNS")
	adminPasswordEnv := os.Getenv("ADMIN_PASSWORD")

	if adminCallsignsEnv != "" && adminPasswordEnv != "" {
		log.Printf("Admin authentication enabled for callsigns: %s\n", adminCallsignsEnv)
	} else {
		log.Println("Admin authentication DISABLED - set both ADMIN_CALLSIGNS and ADMIN_PASSWORD environment variables to enable")
		if adminCallsignsEnv == "" {
			log.Println("  - ADMIN_CALLSIGNS not set (comma-separated list)")
		}
		if adminPasswordEnv == "" {
			log.Println("  - ADMIN_PASSWORD not set")
		}
	}

	err := http.ListenAndServe(":"+port, nil)
	if err != nil {
		log.Fatal(err.Error())
	}
}
