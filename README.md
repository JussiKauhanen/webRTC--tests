# water.io direct

A tiny, static, browser-to-browser chat for sending messages and photos between
two devices. There is no account, app install, chat database, or message server.
The devices exchange their WebRTC connection details by QR code and then talk
directly.

The project is intentionally plain HTML, CSS, and JavaScript so it can be hosted
on GitHub Pages or any other static host.

## Screenshots

| Landing page | Active chat |
| --- | --- |
| **Screenshot placeholder**<br>Add `docs/screenshots/landing.png` | **Screenshot placeholder**<br>Add `docs/screenshots/chat.png` |
| Desktop presentation with the live app inside the phone frame. | The connected mobile chat with a message and photo. |

When the screenshots are ready, replace the table above with:

```md
| Landing page | Active chat |
| --- | --- |
| ![water.io direct landing page](docs/screenshots/landing.png) | ![water.io direct chat](docs/screenshots/chat.png) |
```

## What it does

- Sends text and emoji over an encrypted WebRTC data channel.
- Resizes photos to a maximum dimension of 900 px before sending.
- Pairs devices with QR codes, with text codes as a fallback.
- Keeps chat history locally on each device using IndexedDB.
- Detects interrupted connections and offers a clear QR reconnection flow.
- Requests a screen wake lock while a chat is active.
- Follows the device's light or dark appearance automatically.
- Shows a promotional layout on desktop while keeping the real app usable
  inside the phone mockup.
- Stays a full-screen, touch-friendly app on mobile.

## Pair two phones

1. Open the page on both phones.
2. On the first phone, choose **Host a chat**.
3. On the second phone, choose **Join a chat** and scan the host's QR code.
4. The second phone displays an answer QR code. Scan it with the first phone.
5. Start chatting.

The final return scan is required because this project has no signaling server.
Each phone must receive the other phone's WebRTC connection description before
the direct channel can open.

## Run locally

Serve the repository over HTTP rather than opening `index.html` as a local file:

```sh
cd /path/to/water.io
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173/webrtc-poc/
```

For camera access on another physical device, deploy the directory to an HTTPS
static host. Browsers generally allow camera access on HTTPS and on localhost,
but not on an ordinary LAN HTTP address.

## Static hosting

Deploy the contents of `webrtc-poc/` as-is. No build command or backend
environment variables are required.

The app uses public STUN servers for address discovery. It does not include a
TURN relay, so pairing can fail on restrictive carrier or corporate networks
even when both devices have internet access.

## Privacy and storage

- Messages and photos travel through the WebRTC connection, not through this
  static website's host.
- WebRTC data channels are encrypted in transit.
- The QR codes contain temporary WebRTC connection information. Treat them like
  a short-lived invitation and only show them to the intended person.
- Chat history is stored separately on each device in that browser's IndexedDB.
  It can be removed with **Clear it** on the start screen or by clearing the
  site's browser data.
- Public STUN servers can observe network-address discovery traffic, but they do
  not relay the chat content.

## Connection and sleep behavior

The app asks the browser to keep the screen awake during a connected chat. This
reduces disconnects, but the operating system can still suspend a browser tab.
If the peer connection can no longer recover after wake-up, the messages remain
on the device and the app offers fresh QR controls.

A static page cannot permanently remember or recreate a live WebRTC connection:
connection credentials are temporary, network addresses change, and both
browsers must be awake. A fully automatic reconnect after a long suspension
would require a signaling service.

## Project structure

```text
webrtc-poc/
├── index.html       App and responsive desktop presentation
├── style.css        Mobile UI, phone mockup, and light/dark themes
├── app.js           WebRTC, QR pairing, history, images, and wake lock
├── assets/          Local visual assets
└── vendor/          Pinned QR generation and scanning libraries
```

## Browser notes

Use a current version of Safari, Chrome, Edge, or Firefox. Camera permission is
needed to scan QR codes. Screen Wake Lock support and background-tab behavior
vary by browser and operating system.

## Scope

This proof of concept supports one-to-one chats. A group version would need a
different connection topology and, for practical use, a small signaling layer.

