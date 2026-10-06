const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");
const { google } = require("googleapis");

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

const SCOPES = [
  "https://www.googleapis.com/auth/youtube"
];

let oauthTokens = null;
let active = null;

const ytDlpPath = path.join(__dirname, "yt-dlp");

const ffmpegDir = path.join(os.tmpdir(), "livebridge-ffmpeg");
const ffmpegArchive = path.join(
  os.tmpdir(),
  "livebridge-ffmpeg.tar.xz"
);

const ffmpegBinaryPath = path.join(
  ffmpegDir,
  "ffmpeg"
);

/*
 * Fixed known-good Linux x86_64 static build.
 *
 * Infrlo is running a Linux x86_64 environment.
 */
const FFMPEG_URL =
  "https://www.johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0.1-amd64-static.tar.xz";


function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;

  console.log(line);

  if (active) {
    active.logs.push(line);

    if (active.logs.length > 300) {
      active.logs.shift();
    }
  }
}


function ensureConfig() {
  const missing = [];

  if (!BASE_URL) {
    missing.push("PUBLIC_BASE_URL");
  }

  if (!CLIENT_ID) {
    missing.push("GOOGLE_CLIENT_ID");
  }

  if (!CLIENT_SECRET) {
    missing.push("GOOGLE_CLIENT_SECRET");
  }

  return missing;
}


function getOAuthClient() {
  return new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    OAUTH_REDIRECT
  );
}


/*
 * Download helper with redirect support.
 */
function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);

    const request = https.get(url, (res) => {

      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        file.close();

        try {
          fs.unlinkSync(destination);
        } catch (_) {}

        return downloadFile(
          res.headers.location,
          destination
        ).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        file.close();

        try {
          fs.unlinkSync(destination);
        } catch (_) {}

        reject(
          new Error(
            `Download HTTP ${res.statusCode} from ${url}`
          )
        );

        return;
      }

      res.pipe(file);

      file.on("finish", () => {
        file.close(() => resolve());
      });
    });

    request.on("error", (err) => {
      file.close();

      try {
        fs.unlinkSync(destination);
      } catch (_) {}

      reject(err);
    });
  });
}


/*
 * Recursively find a file.
 */
function findFileRecursive(directory, filename) {
  if (!fs.existsSync(directory)) {
    return null;
  }

  const entries = fs.readdirSync(directory, {
    withFileTypes: true
  });

  for (const entry of entries) {
    const fullPath = path.join(
      directory,
      entry.name
    );

    if (entry.isDirectory()) {
      const found = findFileRecursive(
        fullPath,
        filename
      );

      if (found) {
        return found;
      }
    }

    if (
      entry.isFile() &&
      entry.name === filename
    ) {
      return fullPath;
    }
  }

  return null;
}


/*
 * Download and prepare standalone FFmpeg.
 */
async function ensureFFmpeg() {

  if (fs.existsSync(ffmpegBinaryPath)) {
    return ffmpegBinaryPath;
  }

  /*
   * If we already extracted the archive but the
   * executable is in a versioned directory, find it.
   */
  if (fs.existsSync(ffmpegDir)) {

    const existing = findFileRecursive(
      ffmpegDir,
      "ffmpeg"
    );

    if (existing) {
      fs.chmodSync(existing, 0o755);
      return existing;
    }
  }

  if (process.arch !== "x64") {
    throw new Error(
      `Unsupported CPU architecture: ${process.arch}. ` +
      `This FFmpeg build requires x86_64.`
    );
  }

  log("Preparing standalone FFmpeg...");
  log(`FFmpeg architecture: ${process.arch}`);

  if (!fs.existsSync(ffmpegDir)) {
    fs.mkdirSync(ffmpegDir, {
      recursive: true
    });
  }

  if (!fs.existsSync(ffmpegArchive)) {
    log("Downloading standalone FFmpeg (~39 MB)...");

    await downloadFile(
      FFMPEG_URL,
      ffmpegArchive
    );

    log("FFmpeg download completed.");
  }

  log("Extracting standalone FFmpeg...");

  await new Promise((resolve, reject) => {

    const tar = spawn(
      "tar",
      [
        "-xJf",
        ffmpegArchive,
        "-C",
        ffmpegDir
      ],
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stderr = "";

    tar.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    tar.on("error", reject);

    tar.on("close", (code) => {

      if (code !== 0) {
        reject(
          new Error(
            `tar extraction failed with code ${code}: ${stderr}`
          )
        );

        return;
      }

      resolve();
    });
  });

  const found = findFileRecursive(
    ffmpegDir,
    "ffmpeg"
  );

  if (!found) {
    throw new Error(
      "FFmpeg binary was not found after extraction."
    );
  }

  fs.chmodSync(found, 0o755);

  log(`FFmpeg binary ready: ${found}`);

  return found;
}


/*
 * Test FFmpeg BEFORE creating a YouTube broadcast.
 *
 * This prevents creating a "Waiting" broadcast when
 * FFmpeg itself cannot run.
 */
async function testFFmpeg(ffmpegPath) {

  log("Testing FFmpeg binary...");

  return new Promise((resolve, reject) => {

    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-version"
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      }
    );

    let output = "";
    let errorOutput = "";

    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    child.on("error", (err) => {
      reject(
        new Error(
          `FFmpeg could not start: ${err.message}`
        )
      );
    });

    child.on("close", (code, signal) => {

      if (code === 0) {
        const firstLine =
          output
            .split(/\r?\n/)
            .find(Boolean) ||
          "FFmpeg started successfully.";

        log(`FFmpeg self-test OK: ${firstLine}`);

        resolve();
        return;
      }

      reject(
        new Error(
          `FFmpeg self-test failed. code=${code} ` +
          `signal=${signal || "none"} ` +
          `${errorOutput.trim()}`
        )
      );
    });
  });
}


/*
 * Download yt-dlp standalone.
 */
async function ensureYtDlp() {

  if (fs.existsSync(ytDlpPath)) {
    return ytDlpPath;
  }

  log("Downloading yt-dlp standalone binary...");

  const url =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

  await downloadFile(
    url,
    ytDlpPath
  );

  fs.chmodSync(
    ytDlpPath,
    0o755
  );

  log("yt-dlp ready.");

  return ytDlpPath;
}


/*
 * Resolve currently-live Bilibili media URL.
 */
async function resolveLiveUrl(sourceUrl) {

  const ytdlp = await ensureYtDlp();

  return new Promise((resolve, reject) => {

    const args = [
      "--no-warnings",
      "--no-playlist",

      "--add-header",
      "Referer: https://live.bilibili.com/",

      "--add-header",
      "User-Agent: Mozilla/5.0 " +
      "(Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 " +
      "(KHTML, like Gecko) " +
      "Chrome/140.0.0.0 Safari/537.36",

      "-f",
      "best",

      "-g",

      sourceUrl
    ];

    log("Resolving with yt-dlp...");

    const child = spawn(
      ytdlp,
      args,
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      }
    );

    let out = "";
    let err = "";

    child.stdout.on("data", (data) => {
      out += data.toString();
    });

    child.stderr.on("data", (data) => {
      err += data.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {

      const urls = out
        .trim()
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);

      if (
        code !== 0 ||
        urls.length === 0
      ) {

        reject(
          new Error(
            `yt-dlp could not resolve the live stream. ` +
            `${err.trim()}`
          )
        );

        return;
      }

      resolve(urls[0]);
    });
  });
}


/*
 * Create YouTube broadcast and ingestion stream.
 */
async function createYouTubeBroadcast(
  title,
  description,
  privacy
) {

  const auth = getOAuthClient();

  auth.setCredentials(
    oauthTokens
  );

  const youtube = google.youtube({
    version: "v3",
    auth
  });

  const start =
    new Date(
      Date.now() + 60_000
    ).toISOString();

  const broadcastResponse =
    await youtube.liveBroadcasts.insert({

      part:
        "snippet,status,contentDetails",

      requestBody: {

        snippet: {
          title: title.slice(0, 100),

          description:
            (description || "")
              .slice(0, 5000),

          scheduledStartTime:
            start,

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

  const broadcast =
    broadcastResponse.data;

  const streamResponse =
    await youtube.liveStreams.insert({

      part:
        "snippet,cdn,contentDetails",

      requestBody: {

        snippet: {
          title:
            `${title.slice(0, 90)} - LiveBridge`
        },

        cdn: {

          ingestionType:
            "rtmp",

          resolution:
            "720p",

          frameRate:
            "30fps"
        },

        contentDetails: {
          isReusable: false
        }
      }
    });

  const stream =
    streamResponse.data;

  await youtube.liveBroadcasts.bind({

    part:
      "id,snippet,contentDetails,status",

    id:
      broadcast.id,

    streamId:
      stream.id
  });

  return {

    youtube,

    broadcastId:
      broadcast.id,

    streamId:
      stream.id,

    ingestionAddress:
      stream.cdn
        .ingestionInfo
        .rtmpsIngestionAddress,

    streamName:
      stream.cdn
        .ingestionInfo
        .streamName
  };
}


/*
 * Start real-time FFmpeg relay.
 */
function startRelay(
  sourceUrl,
  ingestionUrl,
  streamName,
  ffmpegPath
) {

  const input =
    `${ingestionUrl}/${streamName}`;

  /*
   * Bilibili often expects these headers.
   */
  const headers =
    "Referer: https://live.bilibili.com/\r\n" +
    "User-Agent: Mozilla/5.0 " +
    "(Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 " +
    "(KHTML, like Gecko) " +
    "Chrome/140.0.0.0 Safari/537.36\r\n";

  /*
   * 720x1280 keeps CPU requirements reasonable
   * for the free Infrlo instance.
   *
   * 30 FPS.
   * H.264.
   * AAC.
   * 2-second keyframes.
   */
  const args = [

    "-hide_banner",

    "-loglevel",
    "info",

    "-nostdin",

    "-rw_timeout",
    "15000000",

    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_delay_max",
    "10",

    "-headers",
    headers,

    "-i",
    sourceUrl,

    "-vf",
    "scale=720:1280:" +
    "force_original_aspect_ratio=decrease," +
    "pad=720:1280:(ow-iw)/2:(oh-ih)/2," +
    "format=yuv420p",

    "-r",
    "30",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-tune",
    "zerolatency",

    "-pix_fmt",
    "yuv420p",

    "-b:v",
    "2500k",

    "-minrate",
    "2500k",

    "-maxrate",
    "2500k",

    "-bufsize",
    "5000k",

    "-g",
    "60",

    "-keyint_min",
    "60",

    "-sc_threshold",
    "0",

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-ar",
    "44100",

    "-ac",
    "2",

    "-f",
    "flv",

    input
  ];

  log(
    `Starting FFmpeg relay: ${ffmpegPath}`
  );

  log(
    "Output: 720x1280 / H.264 / AAC / 30 FPS"
  );

  const ff =
    spawn(
      ffmpegPath,
      args,
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      }
    );

  active.ffmpeg = ff;

  ff.stdout.on("data", (data) => {

    const text =
      data.toString().trim();

    if (text) {
      log(`FFmpeg: ${text}`);
    }
  });

  ff.stderr.on("data", (data) => {

    const text =
      data.toString().trim();

    if (text) {
      log(`FFmpeg: ${text}`);
    }
  });

  ff.on("error", (err) => {

    log(
      `FFmpeg process error: ${err.message}`
    );

    if (active) {
      active.status = "ERROR";
    }
  });

  ff.on("close", (code, signal) => {

    log(
      `FFmpeg exited code=${code} ` +
      `signal=${signal || "none"}`
    );

    if (!active) {
      return;
    }

    if (
      code === 0 &&
      !signal
    ) {
      active.status = "ENDED";
    } else {
      active.status = "ERROR";
    }
  });

  return ff;
}


/*
 * Stop active relay.
 */
function stopActive() {

  if (!active) {
    return;
  }

  if (
    active.ffmpeg &&
    !active.ffmpeg.killed
  ) {

    active.ffmpeg.kill(
      "SIGTERM"
    );
  }

  active.status = "STOPPED";
}


/*
 * Health endpoint.
 */
app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      configured:
        ensureConfig().length === 0,

      authenticated:
        !!oauthTokens,

      active:
        !!active,

      status:
        active?.status || "IDLE"
    });
  }
);


/*
 * Status endpoint.
 */
app.get(
  "/api/status",
  (req, res) => {

    res.json({

      authenticated:
        !!oauthTokens,

      status:
        active?.status || "IDLE",

      broadcastId:
        active?.broadcastId || null,

      youtubeUrl:
        active?.broadcastId
          ? `https://www.youtube.com/watch?v=${active.broadcastId}`
          : null,

      startedAt:
        active?.startedAt || null,

      logs:
        active?.logs || []
    });
  }
);


/*
 * YouTube OAuth start.
 */
app.get(
  "/auth/youtube/start",
  (req, res) => {

    const missing =
      ensureConfig();

    if (missing.length) {

      return res
        .status(500)
        .send(
          `Missing environment variables: ` +
          `${missing.join(", ")}`
        );
    }

    const client =
      getOAuthClient();

    const url =
      client.generateAuthUrl({

        access_type:
          "offline",

        prompt:
          "consent",

        scope:
          SCOPES
      });

    res.redirect(url);
  }
);


/*
 * YouTube OAuth callback.
 */
app.get(
  "/auth/youtube/callback",
  async (req, res) => {

    try {

      if (!req.query.code) {

        return res
          .status(400)
          .send(
            "Missing OAuth code."
          );
      }

      const client =
        getOAuthClient();

      const { tokens } =
        await client.getToken(
          req.query.code
        );

      oauthTokens =
        tokens;

      log(
        "YouTube account authorized."
      );

      res.redirect("/");

    } catch (e) {

      console.error(e);

      res
        .status(500)
        .send(
          `OAuth failed: ${e.message}`
        );
    }
  }
);


/*
 * START LIVE.
 */
app.post(
  "/api/start",
  async (req, res) => {

    if (
      active &&
      [
        "STARTING",
        "LIVE"
      ].includes(
        active.status
      )
    ) {

      return res
        .status(409)
        .json({
          error:
            "A relay is already running."
        });
    }

    if (!oauthTokens) {

      return res
        .status(401)
        .json({
          error:
            "Authorize YouTube first."
        });
    }

    const sourceUrl =
      String(
        req.body.sourceUrl || ""
      ).trim();

    const title =
      String(
        req.body.title ||
        "LiveBridge LIVE"
      ).trim();

    const description =
      String(
        req.body.description || ""
      ).trim();

    const privacy =
      [
        "public",
        "unlisted",
        "private"
      ].includes(
        req.body.privacy
      )
        ? req.body.privacy
        : "unlisted";

    if (
      !/^https?:\/\/(www\.)?live\.bilibili\.com\//i
        .test(sourceUrl)
    ) {

      return res
        .status(400)
        .json({
          error:
            "Enter a live.bilibili.com URL."
        });
    }

    if (!title) {

      return res
        .status(400)
        .json({
          error:
            "Enter a title."
        });
    }

    active = {

      status:
        "STARTING",

      logs: [],

      startedAt:
        new Date().toISOString(),

      ffmpeg:
        null,

      broadcastId:
        null
    };

    res.json({
      ok: true
    });

    /*
     * Run asynchronously.
     */
    (async () => {

      try {

        /*
         * FIRST:
         * Verify FFmpeg itself works.
         *
         * This happens BEFORE YouTube broadcast creation.
         */
        log(
          "Checking FFmpeg runtime..."
        );

        const ffmpegPath =
          await ensureFFmpeg();

        await testFFmpeg(
          ffmpegPath
        );

        /*
         * SECOND:
         * Resolve the currently-live
         * Bilibili media URL.
         */
        log(
          "Resolving currently-live Bilibili stream..."
        );

        const liveUrl =
          await resolveLiveUrl(
            sourceUrl
          );

        log(
          "Bilibili live media URL resolved."
        );

        /*
         * THIRD:
         * Create YouTube broadcast.
         */
        log(
          "Creating YouTube broadcast and ingestion stream..."
        );

        const yt =
          await createYouTubeBroadcast(
            title,
            description,
            privacy
          );

        active.broadcastId =
          yt.broadcastId;

        log(
          `YouTube broadcast created: ` +
          `${yt.broadcastId}`
        );

        /*
         * FOURTH:
         * Start real-time relay.
         */
        active.status =
          "LIVE";

        log(
          "Starting real-time FFmpeg relay..."
        );

        startRelay(
          liveUrl,
          yt.ingestionAddress,
          yt.streamName,
          ffmpegPath
        );

        /*
         * Maximum stream duration.
         */
        setTimeout(
          () => {

            if (
              active &&
              active.status === "LIVE"
            ) {

              log(
                "Maximum stream duration reached; stopping relay."
              );

              stopActive();
            }

          },
          MAX_STREAM_SECONDS * 1000
        );

      } catch (e) {

        log(
          `START FAILED: ` +
          `${e.stack || e.message}`
        );

        if (active) {
          active.status =
            "ERROR";
        }
      }

    })();
  }
);


/*
 * STOP LIVE.
 */
app.post(
  "/api/stop",
  (req, res) => {

    stopActive();

    res.json({
      ok: true
    });
  }
);


/*
 * Start server.
 */
app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `LiveBridge listening on port ${PORT}`
    );
  }
);
