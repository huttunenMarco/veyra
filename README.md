# Veyra

**Turn the IP cameras you already have into smart sensors, on your own server.**

Describe in plain words what to watch ("does the entrance need snow clearing?", "is the car in the driveway?"). Veyra checks the image with AI, keeps history, and notifies you when something changes, e.g. with a push notification to your phone that includes the snapshot. You can also draw boxes on the image so one camera watches several things at once.

Self-hosted, no account or login, works with most IP cameras (RTSP or HTTP snapshot). You bring your own OpenAI key. The UI is in Swedish.

## Quick start

Requires [Docker](https://docs.docker.com/get-docker/).

```bash
git clone https://github.com/huttunenMarco/veyra.git && cd veyra
docker compose up -d
```

Open **http://localhost:8080** and follow the steps on the start page:

1. Add your OpenAI key under *Inställningar → AI*. Without one, results are simulated.
2. Add a camera under *Kameror → Lägg till kamera* and click *Spara och testa anslutning*.
3. Create a sensor: write what to watch and pick the answer type (yes/no, categories or a number).

To update: `git pull && docker compose up -d --build`.

**Common RTSP addresses:** Tapo `rtsp://<ip>:554/stream1` · Hikvision / Tuya-based (e.g. Deltaco) `rtsp://<ip>:554/Streaming/Channels/101` (sometimes port 8554) · Reolink `rtsp://<ip>:554/h264Preview_01_main` · Dahua `rtsp://<ip>:554/cam/realmonitor?channel=1&subtype=0`. Give the camera a fixed IP in your router, and change default logins like `admin`/`admin`.

## Notifications

The easiest option is **ntfy**: install the ntfy app on your phone, add *Push-notis (ntfy)* under *Integrationer*, subscribe to the same topic in the app, then use it as an action in an automation. Keep the topic name hard to guess: on ntfy.sh it works like a password.

Also available: webhooks (tested), plus e-mail, SMS (Twilio), Slack, Teams, Discord and generic HTTP (🧪 experimental, not yet verified with real accounts). Use *Skicka test* to check.

## Cost

You pay only OpenAI. With `gpt-5-mini`, one analysis costs about $0.0007, so analyzing every minute is roughly $1/day per sensor. Cameras can also run in manual mode (only *Analysera nu*), which is practically free.

## API

No key needed on your network. Write requests need the header `x-veyra-csrf: 1`.

```bash
curl http://<server>:8080/api/v1/sensors/<id>/state
```

Docs at `/api/docs`. The *API* page in the app has more examples, including Home Assistant.

## Security

**There is no login:** anyone who can reach port 8080 can use Veyra. Keep it on your home network, and use a VPN (e.g. Tailscale) for remote access. Camera passwords and keys are encrypted at rest. Only snapshots are stored, never video. Images are sent to OpenAI for analysis.

## More

- **Settings:** everything is configured in the app. Optional environment variables (`PUBLIC_URL`, `OPENAI_API_KEY`, `NOTIFICATIONS_MODE`, …) can be set in `docker-compose.yml`.
- **Development:** `pnpm install`, `pnpm dev:db`, `pnpm dev`, then open http://localhost:5180. Tests: `pnpm test`.

## License

MIT
