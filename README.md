# 👑 White-Label Live Trivia Engine (B & S Wedding Edition)

A high-performance, real-time Kahoot-style quiz application built for **unlimited players** with **zero recurring subscription fees**.

---

## 🚀 Quick Start (Local Run)

1. Double-click `start.bat` or run:
   ```bash
   node server.js
   ```
2. Open the interfaces:
   - **🖥️ Host Big-Screen (Projector / TV / Zoom):** `http://localhost:3000/host`
   - **📱 Player Controller (Mobile):** `http://localhost:3000/play`
   - **⚙️ Admin & Quiz Editor:** `http://localhost:3000/admin`

---

## 📱 How Guests Join on Their Phones

1. **Same Venue / Wi-Fi (Local):** 
   Find your local IP address (e.g. `192.168.1.50`) and guests open `http://192.168.1.50:3000/play` or scan the on-screen QR code.
2. **Cloudflare / Global Deployment (100% Free):**
   - Push this repo to GitHub.
   - Deploy backend to Render / Railway / Fly.io (Free Tier).
   - Or run Cloudflare Tunnel (`cloudflared tunnel`) for an instant, permanent custom HTTPS domain with 0 cold starts!

---

## 🎨 Reusing for Future Clients in Under 2 Minutes

Open `http://localhost:3000/admin`:
1. Change **Event Name** (e.g., *"Acme Corp Annual Gala"*).
2. Change **Logo URL**.
3. Paste the new **Questionnaire JSON** and click Save.
4. Done! Ready to host immediately.
