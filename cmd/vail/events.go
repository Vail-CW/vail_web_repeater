package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
)

// Event represents a scheduled morse code practice event
type Event struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Room        string     `json:"room"`
	Date        string     `json:"date"`
	Time        string     `json:"time"`
	Timezone    string     `json:"timezone"`
	Description string     `json:"description"`
	Email       string     `json:"email"`    // Optional contact email for the host
	Creator     string     `json:"creator"`  // Callsign of the creator
	Recurring   Recurrence `json:"recurring"`
	CreatedAt   int64      `json:"createdAt"`
	UpdatedAt   int64      `json:"updatedAt"`
}

// Recurrence defines how an event repeats
type Recurrence struct {
	Type    string  `json:"type"`    // "once", "daily", "weekly", "monthly"
	Weekday *int    `json:"weekday"` // 0-6 for weekly events
	EndDate *string `json:"endDate"` // Optional end date for recurring events
}

// EventStore manages the events in Firestore
type EventStore struct {
	client *firestore.Client
	mu     sync.RWMutex
}

var eventStore *EventStore

// NewEventStore creates a new event store with Firestore
func NewEventStore(ctx context.Context, projectID string) (*EventStore, error) {
	client, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to create firestore client: %w", err)
	}

	log.Printf("Connected to Firestore in project: %s\n", projectID)
	return &EventStore{client: client}, nil
}

// Close closes the Firestore client
func (es *EventStore) Close() error {
	if es.client != nil {
		return es.client.Close()
	}
	return nil
}

// GetAll returns all events from Firestore
func (es *EventStore) GetAll() []Event {
	es.mu.RLock()
	defer es.mu.RUnlock()

	ctx := context.Background()
	events := make([]Event, 0)

	iter := es.client.Collection("events").Documents(ctx)
	defer iter.Stop()

	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			log.Printf("Error iterating events: %v\n", err)
			break
		}

		var event Event
		if err := doc.DataTo(&event); err != nil {
			log.Printf("Error parsing event document: %v\n", err)
			continue
		}
		events = append(events, event)
	}

	return events
}

// Get returns a single event by ID from Firestore
func (es *EventStore) Get(id string) (Event, bool) {
	es.mu.RLock()
	defer es.mu.RUnlock()

	ctx := context.Background()
	doc, err := es.client.Collection("events").Doc(id).Get(ctx)
	if err != nil {
		return Event{}, false
	}

	var event Event
	if err := doc.DataTo(&event); err != nil {
		log.Printf("Error parsing event: %v\n", err)
		return Event{}, false
	}

	return event, true
}

// Create adds a new event to Firestore
func (es *EventStore) Create(event Event) error {
	es.mu.Lock()
	defer es.mu.Unlock()

	now := time.Now().UnixMilli()
	event.CreatedAt = now
	event.UpdatedAt = now

	ctx := context.Background()
	_, err := es.client.Collection("events").Doc(event.ID).Set(ctx, event)
	if err != nil {
		return fmt.Errorf("error creating event in firestore: %w", err)
	}

	return nil
}

// Update modifies an existing event in Firestore
func (es *EventStore) Update(id string, updatedEvent Event) error {
	es.mu.Lock()
	defer es.mu.Unlock()

	ctx := context.Background()

	// Get existing event to preserve creator and createdAt
	doc, err := es.client.Collection("events").Doc(id).Get(ctx)
	if err != nil {
		return fmt.Errorf("event not found")
	}

	var existingEvent Event
	if err := doc.DataTo(&existingEvent); err != nil {
		return fmt.Errorf("error reading existing event: %w", err)
	}

	// Preserve immutable fields
	updatedEvent.ID = id
	updatedEvent.Creator = existingEvent.Creator
	updatedEvent.CreatedAt = existingEvent.CreatedAt
	updatedEvent.UpdatedAt = time.Now().UnixMilli()

	// Update in Firestore
	_, err = es.client.Collection("events").Doc(id).Set(ctx, updatedEvent)
	if err != nil {
		return fmt.Errorf("error updating event in firestore: %w", err)
	}

	return nil
}

// Delete removes an event from Firestore
func (es *EventStore) Delete(id string) error {
	es.mu.Lock()
	defer es.mu.Unlock()

	ctx := context.Background()
	_, err := es.client.Collection("events").Doc(id).Delete(ctx)
	if err != nil {
		return fmt.Errorf("error deleting event from firestore: %w", err)
	}

	return nil
}

// getAdminCallsigns returns the configured admin callsigns
func getAdminCallsigns() []string {
	// Check for environment variable (comma or semicolon separated list)
	adminCallsignsEnv := os.Getenv("ADMIN_CALLSIGNS")
	if adminCallsignsEnv == "" {
		// No admin callsigns configured - admin features disabled
		return []string{}
	}

	// Replace semicolons with commas for consistent splitting
	// (semicolons are used in deploy.bat since commas delimit env vars)
	adminCallsignsEnv = strings.ReplaceAll(adminCallsignsEnv, ";", ",")

	// Split by comma and trim whitespace
	callsigns := strings.Split(adminCallsignsEnv, ",")
	result := make([]string, 0, len(callsigns))
	for _, cs := range callsigns {
		trimmed := strings.TrimSpace(cs)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

// isAdminCallsign checks if a callsign is an admin
func isAdminCallsign(callsign string) bool {
	adminCallsigns := getAdminCallsigns()
	callsignUpper := strings.ToUpper(callsign)

	for _, admin := range adminCallsigns {
		if strings.ToUpper(admin) == callsignUpper {
			return true
		}
	}
	return false
}

// defaultHiddenCallsigns are callsigns that are always hidden from the public
// user list. These are automated/monitoring clients (e.g. the RBN skimmer
// monitor) that connect as participants but shouldn't be shown as users.
var defaultHiddenCallsigns = []string{"VailReRBN-monitor"}

// getHiddenCallsigns returns callsigns that should be omitted from the user
// list: the built-in defaults plus any configured via the HIDDEN_CALLSIGNS
// environment variable (comma or semicolon separated).
func getHiddenCallsigns() []string {
	result := make([]string, 0, len(defaultHiddenCallsigns)+2)
	result = append(result, defaultHiddenCallsigns...)

	hiddenEnv := os.Getenv("HIDDEN_CALLSIGNS")
	if hiddenEnv != "" {
		// Replace semicolons with commas for consistent splitting
		// (semicolons are used in deploy scripts since commas delimit env vars)
		hiddenEnv = strings.ReplaceAll(hiddenEnv, ";", ",")
		for _, cs := range strings.Split(hiddenEnv, ",") {
			if trimmed := strings.TrimSpace(cs); trimmed != "" {
				result = append(result, trimmed)
			}
		}
	}
	return result
}

// isHiddenCallsign reports whether a callsign should be filtered out of the
// public user list (case-insensitive match against the hidden callsigns).
func isHiddenCallsign(callsign string) bool {
	callsignUpper := strings.ToUpper(strings.TrimSpace(callsign))
	if callsignUpper == "" {
		return false
	}
	for _, hidden := range getHiddenCallsigns() {
		if strings.ToUpper(hidden) == callsignUpper {
			return true
		}
	}
	return false
}

// getAdminPassword returns the configured admin password
func getAdminPassword() string {
	adminPassword := os.Getenv("ADMIN_PASSWORD")
	// No default password - must be explicitly set via environment variable
	return adminPassword
}

// verifyAdminPassword checks if the provided password is correct for admin
func verifyAdminPassword(password string) bool {
	adminPassword := getAdminPassword()
	// If no admin password is configured, reject all authentication attempts
	if adminPassword == "" {
		return false
	}
	return password == adminPassword
}

// GetAdminCallsignsHandler returns the list of admin callsigns (public endpoint)
func GetAdminCallsignsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	callsigns := getAdminCallsigns()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(callsigns)
}

// canModify checks if a user can modify an event
func canModify(event Event, callsign string) bool {
	return event.Creator == callsign
}

// GetEventsHandler returns all events
func GetEventsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Return empty array if event store is not initialized
	if eventStore == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]Event{})
		return
	}

	events := eventStore.GetAll()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(events)
}

// CreateEventHandler creates a new event
func CreateEventHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Read request body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Error reading request body", http.StatusBadRequest)
		return
	}

	var event Event
	err = json.Unmarshal(body, &event)
	if err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate required fields
	if event.Name == "" || event.Room == "" || event.Date == "" || event.Time == "" || event.Creator == "" {
		http.Error(w, "Missing required fields", http.StatusBadRequest)
		return
	}

	// Create event
	err = eventStore.Create(event)
	if err != nil {
		log.Printf("Error creating event: %v\n", err)
		http.Error(w, "Error creating event", http.StatusInternalServerError)
		return
	}

	log.Printf("Event created: %s by %s\n", event.Name, event.Creator)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(event)
}

// UpdateEventHandler updates an existing event
func UpdateEventHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get event ID from query parameter
	eventID := r.URL.Query().Get("id")
	if eventID == "" {
		http.Error(w, "Missing event ID", http.StatusBadRequest)
		return
	}

	// Get callsign and admin password from headers
	callsign := r.Header.Get("X-Callsign")
	adminPassword := r.Header.Get("X-Admin-Password")

	if callsign == "" {
		http.Error(w, "Missing callsign", http.StatusUnauthorized)
		return
	}

	// Check if event exists
	existingEvent, found := eventStore.Get(eventID)
	if !found {
		http.Error(w, "Event not found", http.StatusNotFound)
		return
	}

	// Check permissions
	isCreator := canModify(existingEvent, callsign)
	isAdminUser := isAdminCallsign(callsign) && verifyAdminPassword(adminPassword)

	if !isCreator && !isAdminUser {
		if isAdminCallsign(callsign) && adminPassword == "" {
			// Admin callsign but no password provided
			http.Error(w, "Admin password required", http.StatusUnauthorized)
			return
		}
		http.Error(w, "Not authorized to modify this event", http.StatusForbidden)
		return
	}

	// Read updated event data
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Error reading request body", http.StatusBadRequest)
		return
	}

	var updatedEvent Event
	err = json.Unmarshal(body, &updatedEvent)
	if err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Update event
	err = eventStore.Update(eventID, updatedEvent)
	if err != nil {
		log.Printf("Error updating event: %v\n", err)
		http.Error(w, "Error updating event", http.StatusInternalServerError)
		return
	}

	log.Printf("Event updated: %s by %s\n", eventID, callsign)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(updatedEvent)
}

// DeleteEventHandler deletes an event
func DeleteEventHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get event ID from query parameter
	eventID := r.URL.Query().Get("id")
	if eventID == "" {
		http.Error(w, "Missing event ID", http.StatusBadRequest)
		return
	}

	// Get callsign and admin password from headers
	callsign := r.Header.Get("X-Callsign")
	adminPassword := r.Header.Get("X-Admin-Password")

	if callsign == "" {
		http.Error(w, "Missing callsign", http.StatusUnauthorized)
		return
	}

	// Check if event exists
	existingEvent, found := eventStore.Get(eventID)
	if !found {
		http.Error(w, "Event not found", http.StatusNotFound)
		return
	}

	// Check permissions
	isCreator := canModify(existingEvent, callsign)
	isAdminUser := isAdminCallsign(callsign) && verifyAdminPassword(adminPassword)

	if !isCreator && !isAdminUser {
		if isAdminCallsign(callsign) && adminPassword == "" {
			// Admin callsign but no password provided
			http.Error(w, "Admin password required", http.StatusUnauthorized)
			return
		}
		http.Error(w, "Not authorized to delete this event", http.StatusForbidden)
		return
	}

	// Delete event
	err := eventStore.Delete(eventID)
	if err != nil {
		log.Printf("Error deleting event: %v\n", err)
		http.Error(w, "Error deleting event", http.StatusInternalServerError)
		return
	}

	log.Printf("Event deleted: %s by %s\n", eventID, callsign)

	w.WriteHeader(http.StatusNoContent)
}

// ExportEventsHandler exports all events as JSON file
func ExportEventsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	events := eventStore.GetAll()

	// Set headers for file download
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", "attachment; filename=events.json")

	// Write events as JSON
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	err := encoder.Encode(events)
	if err != nil {
		log.Printf("Error encoding events: %v\n", err)
		http.Error(w, "Error exporting events", http.StatusInternalServerError)
		return
	}

	log.Println("Events exported")
}

// ImportEventsHandler imports events from JSON file (admin only)
func ImportEventsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get callsign and admin password from headers
	callsign := r.Header.Get("X-Callsign")
	adminPassword := r.Header.Get("X-Admin-Password")

	// Verify admin credentials
	if callsign == "" {
		http.Error(w, "Missing callsign", http.StatusUnauthorized)
		return
	}

	if !isAdminCallsign(callsign) || !verifyAdminPassword(adminPassword) {
		http.Error(w, "Admin access required", http.StatusForbidden)
		return
	}

	// Read request body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Error reading request body", http.StatusBadRequest)
		return
	}

	// Parse events
	var events []Event
	err = json.Unmarshal(body, &events)
	if err != nil {
		http.Error(w, "Invalid JSON format", http.StatusBadRequest)
		return
	}

	// Import all events to Firestore
	eventStore.mu.Lock()
	defer eventStore.mu.Unlock()

	ctx := context.Background()
	batch := eventStore.client.Batch()

	// Add all events to batch write
	for _, event := range events {
		docRef := eventStore.client.Collection("events").Doc(event.ID)
		batch.Set(docRef, event)
	}

	// Commit batch write
	_, err = batch.Commit(ctx)
	if err != nil {
		log.Printf("Error saving imported events: %v\n", err)
		http.Error(w, "Error saving events", http.StatusInternalServerError)
		return
	}

	log.Printf("Events imported by %s: %d events\n", callsign, len(events))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"count":   len(events),
	})
}
