# Vail Web Repeater

A real-time Morse code practice platform where users can practice CW (Continuous Wave) together over the internet.

---

## The Official Vail Repeater

**The official Vail repeater is located at [vailmorse.com](https://vailmorse.com).**

We encourage everyone who wants to use Vail to join us there! Having a central community helps CW enthusiasts find each other and practice together, rather than splitting into isolated groups on separate servers.

That said, this project is open source and you're welcome to run your own instance for development, testing, or specific community needs.

### Contributing

We welcome pull requests that align with the Vail Community Values:
- Making Morse code practice accessible and enjoyable
- Building a welcoming, inclusive community for CW enthusiasts of all skill levels
- Keeping the platform simple and focused on its core purpose

Please open an issue first to discuss significant changes before submitting a PR.

---

## Features

### Core Morse Functionality
- **Multiple keyer modes**: Straight key, bug, iambic, ultimatic, and more
- **Physical key support**: Connect real CW keys via Arduino adapter
- **Break-in control**: Toggle broadcasting to others on/off
- **Adjustable timing**: WPM rate, RX delay, tone frequency
- **Visual feedback**: Real-time charts showing key presses and transmissions
- **Live decoder**: Adaptive Morse code decoder for real-time transcription

### Rooms & Connectivity
- **Public rooms**: General, Channel 1-3, Echo, Null, Fortunes, Decoder
- **Custom rooms**: Create named rooms (public or private)
- **Private rooms**: Not shown in public room list, shareable by name
- **Room list display**: See all active public rooms with user counts
- **Auto-reconnect**: Handles disconnections gracefully

### Communication
- **Text chat**: Send/receive messages in any room
- **Chat history**: Last 50 messages preserved per room
- **User list**: See all connected users with callsigns
- **Callsign system**: Set your callsign or use anonymous mode

### Events Calendar
- **Event scheduling**: Create/edit/delete events with date, time, timezone
- **Recurring events**: Daily, weekly, or monthly repeating events
- **Timezone conversion**: Automatically shows events in user's local time
- **DST support**: Handles Daylight Saving Time correctly
- **Calendar view**: Monthly calendar showing all scheduled events

### Technical Features
- **WebSocket protocol**: Binary or JSON message formats
- **Inactivity timeout**: Users disconnected after 30 minutes of no activity
- **Rate limiting**: Prevents message floods
- **Dark mode**: Forced dark theme for better visibility
- **Responsive design**: Works on desktop and mobile
- **PWA support**: Installable as a Progressive Web App

## Architecture

### Backend (Go)
- `cmd/vail/main.go` - HTTP server, WebSocket handler, routing
- `cmd/vail/book.go` - Room management, user tracking, broadcasts
- `cmd/vail/repeater.go` - Per-room message relay, chat history
- `cmd/vail/message.go` - Message encoding/decoding (binary/JSON)
- `cmd/vail/events.go` - Events API with Firestore backend
- `cmd/vail/discord.go` - Discord webhook integration
- `cmd/vail/enigma.go` - Enigma machine simulation

### Frontend (JavaScript ES Modules)
- `static/scripts/vail.mjs` - Main client, keyer logic, UI
- `static/scripts/repeaters.mjs` - WebSocket client, auto-reconnect
- `static/scripts/events.mjs` - Events calendar UI and API
- `static/scripts/keyers.mjs` - Keyer implementations
- `static/scripts/outputs.mjs` - Audio generation (Web Audio API)
- `static/scripts/inputs.mjs` - Keyboard/gamepad input handling
- `static/scripts/decoder.mjs` - Morse code decoder integration

### Data Storage
- **Events**: Google Cloud Firestore (when `GCP_PROJECT` is set)
- **Runtime state**: All in-memory (rooms, clients, messages)
- No database required for basic operation

## Building & Running

### Prerequisites
- Go 1.24 or later
- (Optional) Google Cloud project for Firestore events storage
- (Optional) Discord webhook for join notifications

### Build
```bash
go build -o build/vail ./cmd/vail
```

### Run
```bash
./build/vail
```

The server starts on port 8080 by default. Open http://localhost:8080 in your browser.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8080` | HTTP server port |
| `GCP_PROJECT` | No | - | Google Cloud project ID for Firestore events |
| `ADMIN_CALLSIGNS` | No | - | Comma-separated list of admin callsigns |
| `ADMIN_PASSWORD` | No | - | Password for admin authentication |
| `DISCORD_WEBHOOK_URL` | No | - | Discord webhook for join notifications |
| `BASE_URL` | No | `http://localhost:8080` | Base URL for room links in Discord messages |

**Note**: Admin features are disabled unless both `ADMIN_CALLSIGNS` and `ADMIN_PASSWORD` are set.

### Running Tests
```bash
go test ./cmd/vail
```

## Docker

A Dockerfile is provided for containerized deployments:

```bash
docker build -f build/Dockerfile -t vail-repeater .
docker run -p 8080:8080 vail-repeater
```

## Cloud Deployment

The project is designed to run on Google Cloud Run or similar platforms.

### Recommended Cloud Run Configuration
- **CPU**: 1.0 (required for concurrency > 1)
- **Memory**: 512Mi
- **Concurrency**: 1000 (all users need to be on the same instance)
- **Max Instances**: 1 (shared state requires single instance)
- **Min Instances**: 1 (prevents cold starts)
- **Timeout**: 3600 seconds (supports long-lived WebSocket connections)
- **Session Affinity**: Enabled

### Why Single Instance?
WebSocket rooms require shared state. All users must connect to the same instance to see each other. Multiple instances would create isolated "rooms" where users couldn't interact.

## Room Types

| Room | Description |
|------|-------------|
| **General** | Default room for general practice |
| **1, 2, 3** | Additional public channels |
| **Echo** | Echoes back your transmissions (solo practice) |
| **Null** | Receive-only, no transmit |
| **Fortunes** | Automated fortune cookie transmissions |
| **Decoder** | Built-in live Morse decoder enabled |
| **Custom** | User-created rooms (public or private) |

## WebSocket Protocol

See [docs/protocol.md](docs/protocol.md) for the WebSocket protocol specification.

Supported subprotocols:
- `binary.vailmorse.com` - Binary encoding (production)
- `json.vailmorse.com` - JSON encoding (debugging)

## Discord Integration

Vail can post notifications to a Discord channel when users join public rooms.

### Setup
1. Create a webhook in your Discord server (Server Settings > Integrations > Webhooks)
2. Set the `DISCORD_WEBHOOK_URL` and `BASE_URL` environment variables
3. Restart the server

### Features
- Notifications for public room joins only (not private rooms)
- Session-based notifications with message editing (shows join/leave times)
- Anonymous users filtered out
- 2-minute grace period for reconnections (prevents duplicate notifications)

## Version Updates

When deploying changes to static files, update the version to bust browser caches:

```powershell
cd static
.\update-version.ps1 1.0.10
```

Or manually update `static/version.js` and the `?v=` parameters in HTML files.

## Credits

Based on [Vail by Neale Pickett](https://github.com/nealey/vail).

Currently maintained by **KE9BOS Brett Hollifield**, who operates the official Vail Repeater at [vailmorse.com](https://vailmorse.com).
