# 🌀 Curve Clash

A real-time multiplayer arena game (inspired by *Achtung, die Kurve!*) that runs entirely
in the browser — **no server needed**, so it works perfectly on GitHub Pages.

Everyone steers a constantly-moving light trail. Touch any trail or wall and you're out.
Your trail has random gaps you can slip through. Every player you outlive earns you a
point — first to the target score wins the match.

## How it works (no backend!)

GitHub Pages can only serve static files, so the game uses **WebRTC peer-to-peer
connections** (via [PeerJS](https://peerjs.com) and its free public signaling server).
The player who clicks **Create Game** becomes the authoritative game server in their own
browser; everyone else connects directly to them with a 4-letter room code.

## Playing

1. One player opens the page, enters a name, and clicks **Create Game**.
2. They share the room code (or the **Copy invite link** button) with friends.
3. Friends open the page, enter the code, and **Join** (2–8 players).
4. The host clicks **Start Game**.

**Controls:** `←` / `→` arrow keys or `A` / `D` — on phones, hold the on-screen buttons.
Players who join mid-match wait in the lobby and are dealt into the next round.

### Host settings

The host can tweak the match in the lobby (everyone else sees a live summary):

- **Mode** — score race with an automatic target, *first to N points*, or a fixed
  number of rounds (most points at the end wins).
- **Speed** — slow / normal / fast.
- **Trail gaps** — none, rare, normal, or frequent gaps in the trails.
- **Walls** — deadly, or wrap-around (fly off one edge, appear on the opposite one).
- **Power-ups** — orbs that spawn in the arena:
  ⚡ speed boost (you) · 🐌 slow everyone else · 👻 ghost mode (no trail, pass
  through lines) · 🧽 erase all trails · 🔀 reverse the others' controls.

## Deploying to GitHub Pages

1. Create a new repository on GitHub and push these files:
   ```sh
   git remote add origin https://github.com/<your-username>/<repo>.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment**, set *Source* to
   **Deploy from a branch**, pick branch `main` and folder `/ (root)`, save.
3. Your game is live at `https://<your-username>.github.io/<repo>/` after a minute.

## Testing locally

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000` in two or more tabs/windows — create a game in one,
join with the code from the others.

## Notes

- Players connect to each other over the internet from anywhere — different homes,
  cities, or countries. Nobody needs to be on the same network.
- The free PeerJS cloud broker is used only for the initial handshake; game traffic
  flows peer-to-peer, with free public TURN relays as a fallback for strict routers.
