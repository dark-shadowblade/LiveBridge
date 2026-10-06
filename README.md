# LiveBridge v1

Real-time relay:

Bilibili LIVE URL -> yt-dlp live URL resolution -> FFmpeg -> YouTube Live RTMPS

This version does NOT download the complete live video first. FFmpeg reads the
live source continuously and pushes the output to YouTube.

## What this version does

- Web UI to paste a currently-running Bilibili LIVE URL.
- Google OAuth login using YOUR own OAuth client.
- Creates a YouTube Live broadcast and ingestion stream through the YouTube
  Live Streaming API.
- Binds the broadcast to the ingestion stream.
- Starts the YouTube broadcast.
- Resolves the Bilibili live media URL with yt-dlp.
- Relays it through FFmpeg in real time.
- Converts the picture to a 9:16 canvas.
- Stops when the source ends or MAX_STREAM_SECONDS is reached.
- Keeps credentials/tokens out of the repository.

## Important

You must have permission to rebroadcast the source content.

The first test should use an unlisted/private YouTube broadcast if possible.
Confirm the relay works before making broadcasts public.

## Deploying on Infrlo

Infrlo's Git deployment needs a public GitHub repository URL, a runtime, build
command/start command, and port.

Runtime: Node.js
Build command: npm install
Start command: npm start
Port: 3000

Set these environment variables:

PORT=3000
PUBLIC_BASE_URL=https://YOUR-INFRLO-DOMAIN
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MAX_STREAM_SECONDS=21600

## Google OAuth

Create your own Google OAuth 2.0 Web application in Google Cloud.

Add this exact redirect URI:

https://YOUR-INFRLO-DOMAIN/auth/youtube/callback

Enable YouTube Data API v3 and YouTube Live Streaming API for the project.

The OAuth scope used by this app is:

https://www.googleapis.com/auth/youtube

After deployment, open:

https://YOUR-INFRLO-DOMAIN/auth/youtube/start

Sign in with the Google account that owns the YouTube channel.

## First test

1. Deploy the app.
2. Open /auth/youtube/start.
3. Complete Google authorization.
4. Return to the LiveBridge page.
5. Paste a currently-live Bilibili URL.
6. Enter a title.
7. Choose Unlisted for the first test.
8. Press START LIVE.
9. Watch the status/log panel.

## 9:16 behavior

The default filter is:

scale=1080:1920:force_original_aspect_ratio=decrease,
pad=1080:1920:(ow-iw)/2:(oh-ih)/2

This preserves the source aspect ratio and adds padding instead of cropping.
A later version can add crop/blur/background modes.

## Limitations of v1

- One YouTube OAuth account per deployment.
- No persistent token database; OAuth token is held in server memory.
- Bilibili source URL resolution depends on yt-dlp and the source's current
  accessibility.
- If the Bilibili media URL expires, v1 stops rather than attempting a full
  re-resolution/restart loop.
- The Infrlo free plan is small. 1080x1920 software encoding may be too CPU
  heavy. If the first test is unstable, reduce output to 720x1280 in the
  source code before increasing resources.
