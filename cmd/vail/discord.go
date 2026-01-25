package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// DiscordWebhook holds the webhook URL
type DiscordWebhook struct {
	URL         string
	BaseURL     string // Base URL for creating room links
	WebhookID   string // Extracted from URL
	WebhookToken string // Extracted from URL

	// Message tracking for editing when users leave
	messages map[string]*DiscordMessageInfo // key: "callsign:roomname"

	mu sync.RWMutex
}

// DiscordMessageInfo tracks sent Discord messages
type DiscordMessageInfo struct {
	MessageID     string
	JoinTime      time.Time
	RoomName      string
	Callsign      string
	RoomLink      string
	LeaveTimer    *time.Timer // Timer for grace period before marking as left
	LeaveCanceled chan bool   // Channel to cancel pending leave updates
}

// DiscordMessage represents a Discord webhook message
type DiscordMessage struct {
	Content string `json:"content"`
}

// DiscordMessageResponse represents the response from Discord when sending a message
type DiscordMessageResponse struct {
	ID string `json:"id"`
}

var discordWebhook *DiscordWebhook

// Grace period before marking user as left (handles reconnections/refreshes)
// Extended to 2 minutes to handle temporary connection drops
const leaveGracePeriod = 2 * time.Minute

// InitDiscordWebhook initializes the Discord webhook from environment variables
func InitDiscordWebhook() {
	webhookURL := os.Getenv("DISCORD_WEBHOOK_URL")
	baseURL := os.Getenv("BASE_URL")

	if webhookURL == "" {
		log.Println("DISCORD_WEBHOOK_URL not set - Discord notifications disabled")
		return
	}

	if baseURL == "" {
		baseURL = "http://localhost:8080" // Default for local testing
		log.Printf("BASE_URL not set - using default: %s\n", baseURL)
	}

	// Extract webhook ID and token from URL
	// Format: https://discord.com/api/webhooks/{webhook_id}/{webhook_token}
	webhookID, webhookToken := parseWebhookURL(webhookURL)
	if webhookID == "" || webhookToken == "" {
		log.Printf("ERROR: Invalid Discord webhook URL format. Expected: https://discord.com/api/webhooks/{id}/{token}\n")
		return
	}

	discordWebhook = &DiscordWebhook{
		URL:          webhookURL,
		BaseURL:      baseURL,
		WebhookID:    webhookID,
		WebhookToken: webhookToken,
		messages:     make(map[string]*DiscordMessageInfo),
	}

	log.Println("Discord webhook initialized")
}

// HasPendingLeave checks if a user has a pending leave timer (grace period active)
// This helps detect reconnections that happen after a disconnect
func HasPendingLeave(roomName, callsign string) bool {
	if discordWebhook == nil {
		return false
	}

	cooldownKey := fmt.Sprintf("%s:%s", callsign, roomName)
	discordWebhook.mu.Lock()
	defer discordWebhook.mu.Unlock()

	msgInfo, exists := discordWebhook.messages[cooldownKey]
	if !exists {
		return false
	}

	// Check if there's an active leave timer
	return msgInfo.LeaveTimer != nil
}

// NotifyUserJoined sends a Discord notification when a user joins a public room
func NotifyUserJoined(roomName string, callsign string) {
	// Skip if Discord webhook not configured
	if discordWebhook == nil {
		return
	}

	// Skip if no callsign
	if callsign == "" {
		return
	}

	// Skip anonymous users (callsigns starting with "anon")
	if strings.HasPrefix(strings.ToLower(callsign), "anon") {
		return
	}

	// Check if we already have an active session for this user+room
	cooldownKey := fmt.Sprintf("%s:%s", callsign, roomName)
	discordWebhook.mu.Lock()

	// Check if there's a pending leave update and cancel it (user reconnected)
	// This handles reconnections within the 2-minute grace period
	if msgInfo, exists := discordWebhook.messages[cooldownKey]; exists && msgInfo.LeaveTimer != nil {
		msgInfo.LeaveTimer.Stop()
		msgInfo.LeaveCanceled <- true
		close(msgInfo.LeaveCanceled)
		msgInfo.LeaveTimer = nil
		msgInfo.LeaveCanceled = nil
		log.Printf("Discord: %s rejoined %s within grace period (canceled pending leave update)\n", callsign, roomName)
		discordWebhook.mu.Unlock()
		return
	}

	// If we have an existing message for this user+room, don't send a new notification
	// This handles:
	// 1. Users who have been connected for hours (no need for duplicate notifications)
	// 2. Race condition where new connection joins before old connection cleanup completes
	if _, exists := discordWebhook.messages[cooldownKey]; exists {
		discordWebhook.mu.Unlock()
		log.Printf("Discord: %s already in %s (message exists, no new notification - likely reconnection)\n", callsign, roomName)
		return
	}

	// No existing message - this is a legitimate new join
	now := time.Now()
	discordWebhook.mu.Unlock()

	// Create room link
	roomLink := fmt.Sprintf("%s/?repeater=%s", discordWebhook.BaseURL, url.QueryEscape(roomName))

	// Format message
	message := fmt.Sprintf("📻 **%s** joined room **%s**\n%s", callsign, roomName, roomLink)

	// Send notification asynchronously to avoid blocking
	go func() {
		messageID := sendDiscordMessage(message)
		if messageID != "" {
			// Store message info for later editing when user leaves
			discordWebhook.mu.Lock()
			discordWebhook.messages[cooldownKey] = &DiscordMessageInfo{
				MessageID:     messageID,
				JoinTime:      now,
				RoomName:      roomName,
				Callsign:      callsign,
				RoomLink:      roomLink,
				LeaveTimer:    nil,
				LeaveCanceled: nil,
			}
			discordWebhook.mu.Unlock()
		}
	}()
}

// sendDiscordMessage sends a message to Discord webhook and returns the message ID
func sendDiscordMessage(content string) string {
	if discordWebhook == nil {
		return ""
	}

	msg := DiscordMessage{
		Content: content,
	}

	jsonData, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Error marshaling Discord message: %v\n", err)
		return ""
	}

	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	// Add ?wait=true to get the message ID in response
	webhookURL := discordWebhook.URL + "?wait=true"
	resp, err := client.Post(webhookURL, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("Error sending Discord webhook: %v\n", err)
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("Discord webhook returned status %d\n", resp.StatusCode)
		return ""
	}

	// Parse response to get message ID
	var msgResp DiscordMessageResponse
	if err := json.NewDecoder(resp.Body).Decode(&msgResp); err != nil {
		log.Printf("Error decoding Discord response: %v\n", err)
		return ""
	}

	log.Printf("Discord notification sent: %s (message ID: %s)\n", content, msgResp.ID)
	return msgResp.ID
}

// NotifyUserLeft edits the original Discord message to show the user has left
func NotifyUserLeft(roomName string, callsign string) {
	// Skip if Discord webhook not configured
	if discordWebhook == nil {
		return
	}

	// Skip if no callsign
	if callsign == "" {
		return
	}

	// Skip anonymous users
	if strings.HasPrefix(strings.ToLower(callsign), "anon") {
		return
	}

	cooldownKey := fmt.Sprintf("%s:%s", callsign, roomName)

	// Check if we have a message to edit
	discordWebhook.mu.Lock()
	msgInfo, exists := discordWebhook.messages[cooldownKey]
	if !exists {
		discordWebhook.mu.Unlock()
		return
	}

	// Don't schedule another leave if one is already pending
	if msgInfo.LeaveTimer != nil {
		discordWebhook.mu.Unlock()
		return
	}

	// Create cancel channel
	msgInfo.LeaveCanceled = make(chan bool, 1)
	cancelChan := msgInfo.LeaveCanceled

	// Schedule the leave update with a grace period
	// This allows time for the user to reconnect (e.g., page refresh)
	msgInfo.LeaveTimer = time.AfterFunc(leaveGracePeriod, func() {
		// Check if the leave was canceled (user rejoined)
		select {
		case <-cancelChan:
			log.Printf("Discord: Leave update canceled for %s in %s\n", callsign, roomName)
			return
		default:
			// Proceed with updating the message
			discordWebhook.mu.Lock()
			duration := time.Since(msgInfo.JoinTime)
			delete(discordWebhook.messages, cooldownKey) // Remove from tracking
			discordWebhook.mu.Unlock()

			editDiscordMessage(msgInfo, duration)
		}
	})

	discordWebhook.mu.Unlock()
	log.Printf("Discord: Scheduled leave update for %s in %s (%d seconds grace period)\n",
		callsign, roomName, int(leaveGracePeriod.Seconds()))
}

// editDiscordMessage edits a Discord message to show user has left
func editDiscordMessage(msgInfo *DiscordMessageInfo, duration time.Duration) {
	if discordWebhook == nil {
		return
	}

	// Format duration nicely
	var durationStr string
	hours := int(duration.Hours())
	minutes := int(duration.Minutes()) % 60

	if hours > 0 {
		durationStr = fmt.Sprintf("%dh %dm", hours, minutes)
	} else if minutes > 0 {
		durationStr = fmt.Sprintf("%dm", minutes)
	} else {
		durationStr = "< 1m"
	}

	// Update message to show they left (without room link)
	newContent := fmt.Sprintf("📻 **%s** joined room **%s**\n📻 **%s** left room **%s**\nActive for %s",
		msgInfo.Callsign, msgInfo.RoomName, msgInfo.Callsign, msgInfo.RoomName, durationStr)

	msg := DiscordMessage{
		Content: newContent,
	}

	jsonData, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Error marshaling Discord edit message: %v\n", err)
		return
	}

	// Build edit URL: https://discord.com/api/webhooks/{webhook_id}/{webhook_token}/messages/{message_id}
	editURL := fmt.Sprintf("https://discord.com/api/webhooks/%s/%s/messages/%s",
		discordWebhook.WebhookID, discordWebhook.WebhookToken, msgInfo.MessageID)

	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	req, err := http.NewRequest("PATCH", editURL, bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("Error creating Discord edit request: %v\n", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Error editing Discord message: %v\n", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("Discord message edit returned status %d\n", resp.StatusCode)
		return
	}

	log.Printf("Discord message edited: %s left %s after %s\n", msgInfo.Callsign, msgInfo.RoomName, durationStr)
}

// parseWebhookURL extracts webhook ID and token from the URL
func parseWebhookURL(webhookURL string) (string, string) {
	// Expected format: https://discord.com/api/webhooks/{webhook_id}/{webhook_token}
	parts := strings.Split(webhookURL, "/")
	if len(parts) < 2 {
		return "", ""
	}

	// Get last two parts (token and ID in reverse order)
	token := parts[len(parts)-1]
	webhookID := parts[len(parts)-2]

	return webhookID, token
}
