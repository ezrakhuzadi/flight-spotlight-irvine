# ATC-Drone Control Center

Web-based mission control interface for the ATC-Drone UTM (Unmanned Traffic Management) system. Provides real-time 3D visualization of drone fleet operations, conflict detection, and airspace management.

## Features

- **Live 3D Map** - CesiumJS with Google Photorealistic 3D tiles for real-time drone tracking
- **Fleet Management** - Register, monitor, and command drones (HOLD, RESUME, LAND)
- **Conflict Detection** - Visual alerts when drones violate separation minimums
- **Geofencing** - Define and visualize no-fly zones, restricted areas, and temporary restrictions
- **Mission Planning** - Create flight plans with waypoints and altitude profiles
- **Analytics Dashboard** - Flight statistics, conflict history, fleet performance
- **User Authentication** - Signup/login with session-based auth

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Control Center │────▶│   ATC Server    │◀────│   Drone SDK     │
│   (This Repo)   │     │ (atc-drone/Rust)│     │ (atc-sdk/Rust)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
     Port 5000              Port 3000            Runs on drones
```

## Quick Start

### Prerequisites
- Docker & Docker Compose
- ATC Server running on `localhost:3000`

### Run with Docker

```bash
docker compose up -d
```

Access at: http://localhost:5000

### Default Credentials
- **Guest:** `guest` / `guest123`
- **Admin:** `admin` / `admin123`

## Project Structure

```
├── views/                 # EJS templates
│   ├── dashboard.ejs      # Main dashboard
│   ├── map.ejs            # Live 3D map
│   ├── fleet.ejs          # Drone list
│   ├── missions.ejs       # Mission management
│   ├── geofences.ejs      # Geofence management
│   ├── conflicts.ejs      # Conflict alerts
│   ├── analytics.ejs      # Charts & stats
│   └── settings.ejs       # User settings
├── static/
│   ├── js/                # Frontend JavaScript
│   │   ├── map.js         # Cesium 3D map logic
│   │   ├── geofences.js   # Geofence visualization
│   │   └── api-client.js  # ATC server API client
│   └── css/               # Stylesheets
├── routes/
│   └── control.js         # Express routes
└── server.js              # Main server entry
```

## SDK Documentation

Visit `/docs` for the drone integration SDK documentation, including:
- Quick start guide
- API reference
- Code examples

## Related Repositories

- **[atc-drone](https://github.com/ezrakhuzadi/atc-drone)** - Rust backend server and SDK

## Tech Stack

- **Frontend:** Node.js, Express, EJS, CesiumJS, Chart.js
- **3D Tiles:** Google Photorealistic 3D Tiles via Cesium Ion
- **Backend:** Connects to ATC Server (Rust/Axum)

## License

Apache 2.0
