package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
)

// EnigmaSettings represents the Enigma machine configuration
type EnigmaSettings struct {
	Rotors         []string `json:"rotors"`         // e.g., ["III", "II", "I"]
	RotorPositions []string `json:"rotorPositions"` // e.g., ["A", "B", "C"]
	RingSettings   []string `json:"ringSettings"`   // e.g., ["1", "1", "1"]
	Reflector      string   `json:"reflector"`      // e.g., "B"
	Plugboard      string   `json:"plugboard"`      // e.g., "AB CD EF GH"
}

// EnigmaPuzzle represents a Weekly Enigma puzzle
type EnigmaPuzzle struct {
	ID             string         `json:"id"`
	EncodedMessage string         `json:"encodedMessage"`
	DecodedMessage string         `json:"decodedMessage,omitempty"` // Omitted for non-admin requests
	Settings       EnigmaSettings `json:"settings"`
	CreatedBy      string         `json:"createdBy"`
	CreatedAt      int64          `json:"createdAt"`
	UpdatedAt      int64          `json:"updatedAt"`
}

// EnigmaSolve represents a successful puzzle solve
type EnigmaSolve struct {
	ID       string `json:"id" firestore:"id"`             // Composite: {puzzleID}_{callsign}
	Callsign string `json:"callsign" firestore:"callsign"` // User's callsign at time of solve
	PuzzleID string `json:"puzzleId" firestore:"puzzleId"` // Puzzle's CreatedAt timestamp as string
	SolvedAt int64  `json:"solvedAt" firestore:"solvedAt"` // Unix timestamp in milliseconds
}

// LeaderboardEntry represents a user's stats on the leaderboard
type LeaderboardEntry struct {
	Callsign    string `json:"callsign"`
	TotalSolves int    `json:"totalSolves"`
	LastSolveAt int64  `json:"lastSolveAt"`
}

// EnigmaStore manages the enigma puzzle in Firestore
type EnigmaStore struct {
	client *firestore.Client
	mu     sync.RWMutex
}

var enigmaStore *EnigmaStore

// NewEnigmaStore creates a new enigma store with Firestore
func NewEnigmaStore(client *firestore.Client) *EnigmaStore {
	return &EnigmaStore{client: client}
}

// GetCurrent returns the current active puzzle
func (es *EnigmaStore) GetCurrent() (*EnigmaPuzzle, error) {
	es.mu.RLock()
	defer es.mu.RUnlock()

	ctx := context.Background()
	doc, err := es.client.Collection("enigma_puzzles").Doc("current").Get(ctx)
	if err != nil {
		return nil, err
	}

	var puzzle EnigmaPuzzle
	if err := doc.DataTo(&puzzle); err != nil {
		return nil, err
	}

	return &puzzle, nil
}

// SetCurrent creates or updates the current puzzle
// If createNew is true, a new CreatedAt timestamp is generated (for new weekly puzzles)
func (es *EnigmaStore) SetCurrent(puzzle EnigmaPuzzle, createNew bool) error {
	es.mu.Lock()
	defer es.mu.Unlock()

	puzzle.ID = "current"
	now := time.Now().UnixMilli()

	ctx := context.Background()

	if !createNew {
		// Try to get existing puzzle to preserve createdAt
		doc, err := es.client.Collection("enigma_puzzles").Doc("current").Get(ctx)
		if err == nil {
			var existingPuzzle EnigmaPuzzle
			if err := doc.DataTo(&existingPuzzle); err == nil {
				puzzle.CreatedAt = existingPuzzle.CreatedAt
			}
		}
	}

	// If createNew or no existing createdAt, use current time
	if puzzle.CreatedAt == 0 {
		puzzle.CreatedAt = now
	}
	puzzle.UpdatedAt = now

	var err error
	_, err = es.client.Collection("enigma_puzzles").Doc("current").Set(ctx, puzzle)
	return err
}

// RecordSolve records a successful puzzle solve
func (es *EnigmaStore) RecordSolve(callsign string, puzzleID string) error {
	es.mu.Lock()
	defer es.mu.Unlock()

	// Create composite ID to prevent duplicates
	docID := fmt.Sprintf("%s_%s", puzzleID, strings.ToUpper(callsign))

	ctx := context.Background()

	// Check if already solved
	_, err := es.client.Collection("enigma_solves").Doc(docID).Get(ctx)
	if err == nil {
		// Already exists - not an error, just skip
		return nil
	}

	solve := EnigmaSolve{
		ID:       docID,
		Callsign: callsign,
		PuzzleID: puzzleID,
		SolvedAt: time.Now().UnixMilli(),
	}

	_, err = es.client.Collection("enigma_solves").Doc(docID).Set(ctx, solve)
	return err
}

// HasSolved checks if a user has already solved a specific puzzle
func (es *EnigmaStore) HasSolved(callsign string, puzzleID string) bool {
	es.mu.RLock()
	defer es.mu.RUnlock()

	docID := fmt.Sprintf("%s_%s", puzzleID, strings.ToUpper(callsign))
	ctx := context.Background()

	_, err := es.client.Collection("enigma_solves").Doc(docID).Get(ctx)
	return err == nil
}

// GetLeaderboard returns aggregated leaderboard data
func (es *EnigmaStore) GetLeaderboard() ([]LeaderboardEntry, error) {
	es.mu.RLock()
	defer es.mu.RUnlock()

	ctx := context.Background()

	// Get all solves
	iter := es.client.Collection("enigma_solves").Documents(ctx)
	defer iter.Stop()

	// Aggregate by callsign (case-insensitive)
	stats := make(map[string]*LeaderboardEntry)

	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}

		var solve EnigmaSolve
		if err := doc.DataTo(&solve); err != nil {
			continue
		}

		// Use uppercase callsign as key for case-insensitive aggregation
		key := strings.ToUpper(solve.Callsign)
		entry, exists := stats[key]
		if !exists {
			entry = &LeaderboardEntry{
				Callsign:    solve.Callsign, // Preserve original case from first solve
				TotalSolves: 0,
				LastSolveAt: 0,
			}
			stats[key] = entry
		}

		entry.TotalSolves++
		if solve.SolvedAt > entry.LastSolveAt {
			entry.LastSolveAt = solve.SolvedAt
		}
	}

	// Convert to slice and sort by total solves (descending), then by last solve (descending)
	result := make([]LeaderboardEntry, 0, len(stats))
	for _, entry := range stats {
		result = append(result, *entry)
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].TotalSolves != result[j].TotalSolves {
			return result[i].TotalSolves > result[j].TotalSolves
		}
		return result[i].LastSolveAt > result[j].LastSolveAt
	})

	return result, nil
}

// GetLatestSolve returns the most recent solve (for promo box display)
func (es *EnigmaStore) GetLatestSolve() (*EnigmaSolve, error) {
	es.mu.RLock()
	defer es.mu.RUnlock()

	ctx := context.Background()

	// Get all solves and find the most recent one
	// (simpler approach that doesn't require an index)
	iter := es.client.Collection("enigma_solves").Documents(ctx)
	defer iter.Stop()

	var latest *EnigmaSolve
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}

		var solve EnigmaSolve
		if err := doc.DataTo(&solve); err != nil {
			continue
		}

		if latest == nil || solve.SolvedAt > latest.SolvedAt {
			solveCopy := solve
			latest = &solveCopy
		}
	}

	return latest, nil
}

// GetEnigmaHandler returns the current puzzle (without decoded message for non-admins)
func GetEnigmaHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Return empty if enigma store is not initialized
	if enigmaStore == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": "Enigma feature not available",
		})
		return
	}

	puzzle, err := enigmaStore.GetCurrent()
	if err != nil {
		// No puzzle exists yet
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": "No puzzle available",
		})
		return
	}

	// Strip decoded message for public endpoint
	puzzle.DecodedMessage = ""

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(puzzle)
}

// GetEnigmaFullHandler returns the full puzzle including decoded message (admin only)
func GetEnigmaFullHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Verify admin credentials
	callsign := r.Header.Get("X-Callsign")
	adminPassword := r.Header.Get("X-Admin-Password")

	if callsign == "" {
		http.Error(w, "Missing callsign", http.StatusUnauthorized)
		return
	}

	if !isAdminCallsign(callsign) || !verifyAdminPassword(adminPassword) {
		http.Error(w, "Admin access required", http.StatusForbidden)
		return
	}

	if enigmaStore == nil {
		http.Error(w, "Enigma feature not available", http.StatusServiceUnavailable)
		return
	}

	puzzle, err := enigmaStore.GetCurrent()
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": "No puzzle available",
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(puzzle)
}

// UpdateEnigmaHandler creates or updates the current puzzle (admin only)
func UpdateEnigmaHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Verify admin credentials
	callsign := r.Header.Get("X-Callsign")
	adminPassword := r.Header.Get("X-Admin-Password")

	if callsign == "" {
		http.Error(w, "Missing callsign", http.StatusUnauthorized)
		return
	}

	if !isAdminCallsign(callsign) {
		http.Error(w, "Admin access required", http.StatusForbidden)
		return
	}

	if !verifyAdminPassword(adminPassword) {
		if adminPassword == "" {
			http.Error(w, "Admin password required", http.StatusUnauthorized)
		} else {
			http.Error(w, "Invalid admin password", http.StatusForbidden)
		}
		return
	}

	if enigmaStore == nil {
		http.Error(w, "Enigma feature not available", http.StatusServiceUnavailable)
		return
	}

	// Read request body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Error reading request body", http.StatusBadRequest)
		return
	}

	// Parse request including the createNew flag
	var request struct {
		EnigmaPuzzle
		CreateNew bool `json:"createNew"`
	}
	err = json.Unmarshal(body, &request)
	if err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	puzzle := request.EnigmaPuzzle

	// Validate required fields
	if puzzle.EncodedMessage == "" {
		http.Error(w, "Missing encoded message", http.StatusBadRequest)
		return
	}
	if puzzle.DecodedMessage == "" {
		http.Error(w, "Missing decoded message", http.StatusBadRequest)
		return
	}
	if len(puzzle.Settings.Rotors) == 0 {
		http.Error(w, "Missing rotor settings", http.StatusBadRequest)
		return
	}

	// Set creator
	puzzle.CreatedBy = callsign

	// Save puzzle (createNew determines if this is a new weekly puzzle)
	err = enigmaStore.SetCurrent(puzzle, request.CreateNew)
	if err != nil {
		log.Printf("Error saving enigma puzzle: %v\n", err)
		http.Error(w, "Error saving puzzle", http.StatusInternalServerError)
		return
	}

	action := "updated"
	if request.CreateNew {
		action = "created (new week)"
	}
	log.Printf("Enigma puzzle %s by %s\n", action, callsign)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Puzzle updated successfully",
	})
}

// CheckEnigmaAnswerHandler checks if a submitted answer is correct
func CheckEnigmaAnswerHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if enigmaStore == nil {
		http.Error(w, "Enigma feature not available", http.StatusServiceUnavailable)
		return
	}

	// Get callsign from header
	callsign := r.Header.Get("X-Callsign")

	// Read request body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Error reading request body", http.StatusBadRequest)
		return
	}

	var request struct {
		Answer   string `json:"answer"`
		Callsign string `json:"callsign"` // Optional: can also come from header
	}
	err = json.Unmarshal(body, &request)
	if err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Use callsign from body if header not provided
	if callsign == "" {
		callsign = request.Callsign
	}

	puzzle, err := enigmaStore.GetCurrent()
	if err != nil {
		http.Error(w, "No puzzle available", http.StatusNotFound)
		return
	}

	// Normalize and compare answers (case-insensitive, ignore non-alphanumeric)
	correct := normalizeAnswer(request.Answer) == normalizeAnswer(puzzle.DecodedMessage)

	response := map[string]interface{}{
		"correct": correct,
	}

	// If correct and callsign provided, check if we should record
	if correct && callsign != "" {
		puzzleID := fmt.Sprintf("%d", puzzle.CreatedAt)

		// Check if anonymous (starts with "anon")
		isAnonymous := strings.HasPrefix(strings.ToLower(callsign), "anon")
		alreadySolved := enigmaStore.HasSolved(callsign, puzzleID)

		response["isAnonymous"] = isAnonymous
		response["alreadySolved"] = alreadySolved

		if !isAnonymous && !alreadySolved {
			// Record the solve
			err = enigmaStore.RecordSolve(callsign, puzzleID)
			if err != nil {
				log.Printf("Error recording solve: %v\n", err)
			} else {
				response["recorded"] = true
				log.Printf("Enigma solve recorded: %s\n", callsign)
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// normalizeAnswer normalizes an answer for comparison
func normalizeAnswer(s string) string {
	result := ""
	for _, c := range s {
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			if c >= 'a' && c <= 'z' {
				c = c - 'a' + 'A' // Convert to uppercase
			}
			result += string(c)
		}
	}
	return result
}

// GetEnigmaLeaderboardHandler returns the leaderboard
func GetEnigmaLeaderboardHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if enigmaStore == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]LeaderboardEntry{})
		return
	}

	leaderboard, err := enigmaStore.GetLeaderboard()
	if err != nil {
		log.Printf("Error getting leaderboard: %v\n", err)
		http.Error(w, "Error getting leaderboard", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(leaderboard)
}

// GetLatestSolveHandler returns the most recent solve (for promo box)
func GetLatestSolveHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if enigmaStore == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{})
		return
	}

	solve, err := enigmaStore.GetLatestSolve()
	if err != nil {
		log.Printf("Error getting latest solve: %v\n", err)
		http.Error(w, "Error getting latest solve", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if solve == nil {
		json.NewEncoder(w).Encode(map[string]interface{}{})
	} else {
		json.NewEncoder(w).Encode(solve)
	}
}
