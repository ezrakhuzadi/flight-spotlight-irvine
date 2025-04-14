<img src="images/spotlight-logo.png" width="350">

# Flight Spotlight

Flight Spotlight is a powerful tool that lets you track flights _in real-time_ by subscribing to updates for a specific geographic area. It visualizes live manned and unmanned air traffic on a 3D globe and supports features like geo-fencing. Whether you're working with UTM / U-Space systems or monitoring drone traffic, Flight Spotlight has you covered. It supports Network Remote-ID, broadcast Remote-ID data, and integrates with live ADS-B or other air-traffic data feeds. 

For unmanned aviation, Flight Spotlight currently supports ASTM Network and Broadcast Remote-ID standards, with the flexibility to adopt new standards as they emerge.

Flight Spotlight works seamlessly with [Flight Blender](https://flightblender.com), a complementary server application that processes and streams flight data from various sources like ADS-B, Radar, and FLARM. Flight Blender also provides Network Remote-ID capabilities as a specialized module.

---

## ✨ Features

Flight Spotlight is designed to be compatible with all current and upcoming ASTM and EuroCAE standards for UTM / U-Space. Key features include:

- **Geofencing Display**: Fully compatible with [EuroCAE ED-269](https://eshop.eurocae.net/eurocae-documents-and-reports/ed-269/).
- **Network Remote ID**: Display drone traffic via connections to [DSS](https://github.com/interuss/dss) using [Flight Blender](https://flightblender.com).
- **Manned and Unmanned Traffic**: Visualize ADS-B and other traffic using a streamlined [JSON format](https://github.com/openskies-sh/airtraffic-data-protocol-development) with a Flight Blender backend.
- **Flight Declarations**: Upload JSON-based [flight declarations](https://github.com/openskies-sh/flight-declaration-protocol-development) or mission plans from ground control stations.

---

## 🌍 Join the OpenUTM Community

Connect with other aviation enthusiasts and developers! Join our Discord community via [this link](https://discord.gg/dnRxpZdd9a) 💫

---

## 📸 Screenshots

### Initial Screen
<img src="images/readme-images/6kfx13d.png" width="600">

### Declared Flights
<img src="images/readme-images/zbl6hKx.png" width="600">

### 3D + Time Visualization
<img src="images/readme-images/gysUdTd.jpeg" width="600">

---

## 🚀 Running Locally / Deployment

To deploy Flight Spotlight locally, refer to the [deployment repository](https://github.com/openutm/deployment). It includes detailed instructions and a sample environment file to get you started.

---

## 🛠️ OpenUTM Stack

Flight Spotlight integrates with the OpenUTM stack to visualize flight tracking data. It works alongside UTM data processing engines like [Flight Blender](https://github.com/openskies-sh/flight-blender). Check out the diagram below for more details:

![OpenUTMStack](images/openutm-stack.png)

---

## 🎨 Logo Source

The logo was created using [Hatchful](https://hatchful.shopify.com/).
