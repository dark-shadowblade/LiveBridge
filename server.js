const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");
const { google } = require("googleapis");
const ffmpegPath = require("ffmpeg-static");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = 5000;
const BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const MAX_STREAM_SECONDS = Math.max(
  60,
  Number(process.env.MAX_STREAM_SECONDS || 21600)
);

const OAUTH_REDIRECT = `${BASE_URL}/auth/youtube/callback`;
const SCOPES = ["https://www.googleapis.com/auth/youtube"];

let oauthTokens = null;
let active = null;
let ytDlpPath = path.join(__dirname, "yt-dlp");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (active) {
    active.logs.push(line);
    if (active.logs.length > 250) active.logs.shift();
  }
}

function ensureConfig() {
  const missing = [];
  if (!BASE_URL) missing.push("PUBLIC_BASE_URL");
  if (!CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  return missing;
}

function getOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, OAUTH_REDIRECT);
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    const request = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(destination, () => {});
        return downloadFile(res.headers.location, destination).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destination, () => {});
        return reject(new Error(`yt-dlp download HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    request.on("error", (err) => {
      file.close();
      fs.unlink(destination, () => {});
      reject(err);
    });
  });
}

async function ensureYtDlp() {
  if (fs.existsSync(ytDlpPath)) return ytDlpPath;

  log("Downloading yt-dlp standalone binary...");
  const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
  await downloadFile(url, ytDlpPath);
  fs.chmodSync(ytDlpPath, 0o755);
  log("yt-dlp ready.");
  return ytDlpPath;
}

function spawnLogged(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });

  child.stdout.on("data", (d) => log(String(d).trim()));
  child.stderr.on("data", (d) => log(String(d).trim()));
  return child;
}

async function resolveLiveUrl(sourceUrl) {
  const ytdlp = await ensureYtDlp();

  return new Promise((resolve, reject) => {
    const args = [
      "--no-warnings",
      "--no-playlist",
      "-f", "best",
      "-g",
      sourceUrl
    ];

    const child = spawn(ytdlp, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";

    child.stdout.on("data", d => { out += d.toString(); });
    child.stderr.on("data", d => { err += d.toString(); });

    child.on("error", reject);
    child.on("close", code => {
      const urls = out.trim().split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      if (code !== 0 || !urls.length) {
        reject(new Error(`yt-dlp could not resolve the live stream. ${err.trim()}`));
        return;
      }
      // Usually the best format produces one URL. If multiple appear, use the first.
      resolve(urls[0]);
    });
  });
}

async function createYouTubeBroadcast(title, description, privacy) {
  const auth = getOAuthClient();
  auth.setCredentials(oauthTokens);
  const youtube = google.youtube({ version: "v3", auth });

  const start = new Date(Date.now() + 60_000).toISOString();

  const broadcastResponse = await youtube.liveBroadcasts.insert({
    part: "snippet,status,contentDetails",
    requestBody: {
      snippet: {
        title: title.slice(0, 100),
        description: (description || "").slice(0, 5000),
        scheduledStartTime: start,
        categoryId: "24"
      },
      status: {
        privacyStatus: privacy
      },
      contentDetails: {
        enableAutoStart: true,
        enableAutoStop: true,
        recordFromStart: true,
        enableDvr: true
      }
    }
  });

  const broadcast = broadcastResponse.data;

  const streamResponse = await youtube.liveStreams.insert({
    part: "snippet,cdn,contentDetails",
    requestBody: {
      snippet: {
        title: `${title.slice(0, 90)} - LiveBridge`
      },
      cdn: {
        ingestionType: "rtmp",
        resolution: "720p",
        frameRate: "30fps"
      },
      contentDetails: {
        isReusable: false
      }
    }
  });

  const stream = streamResponse.data;

  await youtube.liveBroadcasts.bind({
    part: "id,snippet,contentDetails,status",
    id: broadcast.id,
    streamId: stream.id
  });

  return {
    youtube,
    broadcastId: broadcast.id,
    streamId: stream.id,
    ingestionAddress: stream.cdn.ingestionInfo.rtmpsIngestionAddress,
    streamName: stream.cdn.ingestionInfo.streamName
  };
}

function startRelay(sourceUrl, ingestionUrl, streamName) {
  const input = `${ingestionUrl}/${streamName}`;

  // 1080x1920 can be too CPU-heavy for tiny free instances.
  // Start at 720x1280 for the first Infrlo test.
  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-nostdin",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "10",
    "-i", sourceUrl,

    "-vf",
    "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2",

    "-r", "30",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-b:v", "2500k",
    "-maxrate", "2500k",
    "-bufsize", "5000k",

    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",

    "-f", "flv",
    input
  ];

  log(`Starting FFmpeg relay: ${ffmpegPath}`);
  const ff = spawnLogged(ffmpegPath, args);

  active.ffmpeg = ff;
  ff.on("close", (code, signal) => {
    log(`FFmpeg exited code=${code} signal=${signal || "none"}`);
    if (active && active.status === "LIVE") {
      active.status = "ENDED";
    }
  });
  ff.on("error", err => {
    log(`FFmpeg error: ${err.message}`);
    if (active) active.status = "ERROR";
  });

  return ff;
}

function stopActive() {
  if (!active) return;
  if (active.ffmpeg && !active.ffmpeg.killed) {
    active.ffmpeg.kill("SIGTERM");
  }
  active.status = "STOPPED";
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    configured: ensureConfig().length === 0,
    authenticated: !!oauthTokens,
    active: !!active,
    status: active?.status || "IDLE"
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    authenticated: !!oauthTokens,
    status: active?.status || "IDLE",
    broadcastId: active?.broadcastId || null,
    youtubeUrl: active?.broadcastId
      ? `https://www.youtube.com/watch?v=${active.broadcastId}`
      : null,
    startedAt: active?.startedAt || null,
    logs: active?.logs || []
  });
});

app.get("/auth/youtube/start", (req, res) => {
  const missing = ensureConfig();
  if (missing.length) {
    return res.status(500).send(`Missing environment variables: ${missing.join(", ")}`);
  }

  const client = getOAuthClient();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });
  res.redirect(url);
});

app.get("/auth/youtube/callback", async (req, res) => {
  try {
    if (!req.query.code) return res.status(400).send("Missing OAuth code.");
    const client = getOAuthClient();
    const { tokens } = await client.getToken(req.query.code);
    oauthTokens = tokens;
    log("YouTube account authorized.");
    res.redirect("/");
  } catch (e) {
    console.error(e);
    res.status(500).send(`OAuth failed: ${e.message}`);
  }
});

app.post("/api/start", async (req, res) => {
  if (active && ["STARTING", "LIVE"].includes(active.status)) {
    return res.status(409).json({ error: "A relay is already running." });
  }
  if (!oauthTokens) {
    return res.status(401).json({ error: "Authorize YouTube first." });
  }

  const sourceUrl = String(req.body.sourceUrl || "").trim();
  const title = String(req.body.title || "LiveBridge LIVE").trim();
  const description = String(req.body.description || "").trim();
  const privacy = ["public", "unlisted", "private"].includes(req.body.privacy)
    ? req.body.privacy
    : "unlisted";

  if (!/^https?:\/\/(www\.)?live\.bilibili\.com\//i.test(sourceUrl)) {
    return res.status(400).json({ error: "Enter a live.bilibili.com URL." });
  }
  if (!title) return res.status(400).json({ error: "Enter a title." });

  active = {
    status: "STARTING",
    logs: [],
    startedAt: new Date().toISOString(),
    ffmpeg: null,
    broadcastId: null
  };

  res.json({ ok: true });

  (async () => {
    try {
      log("Resolving currently-live Bilibili stream...");
      const liveUrl = await resolveLiveUrl(sourceUrl);
      log("Bilibili live media URL resolved.");

      log("Creating YouTube broadcast and ingestion stream...");
      const yt = await createYouTubeBroadcast(title, description, privacy);

      active.broadcastId = yt.broadcastId;
      active.status = "LIVE";
      log(`YouTube broadcast created: ${yt.broadcastId}`);
      log("Starting real-time FFmpeg relay...");

      startRelay(liveUrl, yt.ingestionAddress, yt.streamName);

      setTimeout(() => {
        if (active && active.status === "LIVE") {
          log("Maximum stream duration reached; stopping relay.");
          stopActive();
        }
      }, MAX_STREAM_SECONDS * 1000);

    } catch (e) {
      log(`START FAILED: ${e.stack || e.message}`);
      if (active) active.status = "ERROR";
    }
  })();
});

app.post("/api/stop", (req, res) => {
  stopActive();
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LiveBridge listening on port ${PORT}`);
});
