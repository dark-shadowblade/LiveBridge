const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const { google } = require("googleapis");
const ffmpegPath = require("ffmpeg-static");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 5000);
const BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const MAX_STREAM_SECONDS = Math.max(60, Number(process.env.MAX_STREAM_SECONDS || 21600));

const OAUTH_REDIRECT = `${BASE_URL}/auth/youtube/callback`;
const SCOPES = ["https://www.googleapis.com/auth/youtube"];

let oauthTokens = null;
let active = null;
const ytDlpPath = path.join(__dirname, "yt-dlp");
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

    const request = https.get(
      url,
      { headers: { "User-Agent": USER_AGENT } },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          file.close();
          fs.unlink(destination, () => {});
          return downloadFile(
            new URL(res.headers.location, url).toString(),
            destination
          ).then(resolve, reject);
        }

        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destination, () => {});
          return reject(
            new Error(`yt-dlp download HTTP ${res.statusCode}`)
          );
        }

        res.pipe(file);

        file.on("finish", () => file.close(resolve));
      }
    );

    request.on("error", (err) => {
      file.close();
      fs.unlink(destination, () => {});
      reject(err);
    });
  });
}

async function ensureYtDlp() {
  if (fs.existsSync(ytDlpPath)) return ytDlpPath;

  log("Downloading yt-dlp nightly standalone binary...");

  const url =
    "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux";

  await downloadFile(url, ytDlpPath);

  fs.chmodSync(ytDlpPath, 0o755);

  log("yt-dlp nightly ready.");

  return ytDlpPath;
}

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json, text/plain, */*",
          ...headers,
        },
      },
      (res) => {
        let body = "";

        res.setEncoding("utf8");

        res.on("data", (chunk) => {
          body += chunk;
        });

        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(
                `HTTP ${res.statusCode}: ${body.slice(0, 300)}`
              )
            );
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        });
      }
    );

    request.on("error", reject);
  });
}

function spawnLogged(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  child.stdout.on("data", (data) => {
    const text = String(data).trim();
    if (text) log(text);
  });

  child.stderr.on("data", (data) => {
    const text = String(data).trim();
    if (text) log(text);
  });

  return child;
}

async function resolveWithYtDlp(sourceUrl) {
  const ytdlp = await ensureYtDlp();

  return new Promise((resolve, reject) => {
    const args = [
      "--no-warnings",
      "--no-playlist",
      "-f",
      "best",
      "-g",
      sourceUrl,
    ];

    const child = spawn(ytdlp, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
    });

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

      if (code !== 0 || !urls.length) {
        reject(
          new Error(
            `yt-dlp could not resolve the live stream. ${err.trim()}`
          )
        );
        return;
      }

      resolve({
        url: urls[0],
        headers: {
          Referer: sourceUrl,
          "User-Agent": USER_AGENT,
        },
      });
    });
  });
}

function getRoomId(sourceUrl) {
  const match = sourceUrl.match(
    /live\.bilibili\.com\/(?:blanc\/)?(\d+)/i
  );

  return match ? match[1] : null;
}

async function resolveWithBilibiliApi(sourceUrl) {
  const roomId = getRoomId(sourceUrl);

  if (!roomId) {
    throw new Error("Could not extract Bilibili room ID.");
  }

  log(
    `Trying Bilibili live API fallback for room ${roomId}...`
  );

  const room = await httpGetJson(
    `https://api.live.bilibili.com/room/v1/Room/get_info?id=${encodeURIComponent(
      roomId
    )}`,
    {
      Referer: sourceUrl,
    }
  );

  if (room.code !== 0) {
    throw new Error(
      room.message ||
        `Bilibili room API error ${room.code}`
    );
  }

  const roomData = room.data || {};

  if (Number(roomData.live_status) !== 1) {
    throw new Error(
      "Bilibili room is not currently live."
    );
  }

  const qualities = [
    30000,
    20000,
    10000,
    400,
    250,
    150,
    80,
  ];

  for (const qn of qualities) {
    const params = new URLSearchParams({
      room_id: roomId,
      qn: String(qn),
      codec: "0,1",
      format: "0,2",
      mask: "0",
      no_playurl: "0",
      platform: "web",
      protocol: "0,1",
    });

    const result = await httpGetJson(
      `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?${params}`,
      {
        Referer: sourceUrl,
      }
    );

    if (result.code !== 0) continue;

    const streams =
      result.data?.playurl_info?.playurl?.stream || [];

    const formats = streams.flatMap(
      (stream) => stream.format || []
    );

    for (const fmt of formats) {
      const codecs = fmt.codec || [];

      for (const codec of codecs) {
        if (Number(codec.current_qn) !== qn) {
          continue;
        }

        const urlInfo = (codec.url_info || []).find(
          (x) =>
            x.host &&
            codec.base_url &&
            x.extra !== undefined
        );

        if (!urlInfo) continue;

        const directUrl =
          `${urlInfo.host}` +
          `${codec.base_url}` +
          `${urlInfo.extra}`;

        log(
          `Bilibili API resolved ${qn} quality ` +
            `(${fmt.format_name || "stream"}).`
        );

        return {
          url: directUrl,
          headers: {
            Referer: sourceUrl,
            "User-Agent": USER_AGENT,
          },
        };
      }
    }
  }

  throw new Error(
    "Bilibili API returned no playable stream URLs."
  );
}

async function resolveLiveStream(sourceUrl) {
  try {
    log("Resolving with yt-dlp...");
    return await resolveWithYtDlp(sourceUrl);
  } catch (error) {
    log(
      `yt-dlp resolver failed: ${error.message}`
    );

    log(
      "Falling back to Bilibili's live API..."
    );

    return await resolveWithBilibiliApi(
      sourceUrl
    );
  }
}

async function createYouTubeBroadcast(
  title,
  description,
  privacy
) {
  const auth = getOAuthClient();

  auth.setCredentials(oauthTokens);

  const youtube = google.youtube({
    version: "v3",
    auth,
  });

  const start = new Date(
    Date.now() + 60_000
  ).toISOString();

  const broadcastResponse =
    await youtube.liveBroadcasts.insert({
      part: "snippet,status,contentDetails",

      requestBody: {
        snippet: {
          title: title.slice(0, 100),

          description:
            (description || "").slice(0, 5000),

          scheduledStartTime: start,

          categoryId: "24",
        },

        status: {
          privacyStatus: privacy,
        },

        contentDetails: {
          enableAutoStart: true,
          enableAutoStop: true,
          recordFromStart: true,
          enableDvr: true,
        },
      },
    });

  const broadcast =
    broadcastResponse.data;

  const streamResponse =
    await youtube.liveStreams.insert({
      part: "snippet,cdn,contentDetails",

      requestBody: {
        snippet: {
          title:
            `${title.slice(0, 90)} - LiveBridge`,
        },

        cdn: {
          ingestionType: "rtmp",
          resolution: "720p",
          frameRate: "30fps",
        },

        contentDetails: {
          isReusable: false,
        },
      },
    });

  const stream =
    streamResponse.data;

  await youtube.liveBroadcasts.bind({
    part:
      "id,snippet,contentDetails,status",

    id: broadcast.id,

    streamId: stream.id,
  });

  return {
    youtube,

    broadcastId:
      broadcast.id,

    streamId:
      stream.id,

    ingestionAddress:
      stream.cdn.ingestionInfo
        .rtmpsIngestionAddress,

    streamName:
      stream.cdn.ingestionInfo
        .streamName,
  };
}

function startRelay(
  source,
  ingestionUrl,
  streamName
) {
  const input =
    `${ingestionUrl}/${streamName}`;

  const headers =
    source.headers || {};

  const args = [
    "-hide_banner",

    "-loglevel",
    "warning",

    "-nostdin",

    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_delay_max",
    "10",

    "-user_agent",
    headers["User-Agent"] ||
      USER_AGENT,

    "-headers",
    `Referer: ${
      headers.Referer ||
      "https://live.bilibili.com/"
    }\r\n`,

    "-i",
    source.url,

    "-vf",
    "scale=720:1280:force_original_aspect_ratio=decrease," +
      "pad=720:1280:(ow-iw)/2:(oh-ih)/2",

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

    "-maxrate",
    "2500k",

    "-bufsize",
    "5000k",

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

    input,
  ];

  log(
    `Starting FFmpeg relay: ${ffmpegPath}`
  );

  const ff =
    spawnLogged(
      ffmpegPath,
      args
    );

  active.ffmpeg =
    ff;

  ff.on(
    "close",
    (code, signal) => {
      log(
        `FFmpeg exited code=${code} ` +
          `signal=${signal || "none"}`
      );

      if (
        active &&
        active.status === "LIVE"
      ) {
        active.status =
          "ENDED";
      }
    }
  );

  ff.on(
    "error",
    (err) => {
      log(
        `FFmpeg error: ${err.message}`
      );

      if (active) {
        active.status =
          "ERROR";
      }
    }
  );

  return ff;
}

function stopActive() {
  if (!active) return;

  if (
    active.ffmpeg &&
    !active.ffmpeg.killed
  ) {
    active.ffmpeg.kill(
      "SIGTERM"
    );
  }

  active.status =
    "STOPPED";
}

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
        active?.status ||
        "IDLE",
    });
  }
);

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      authenticated:
        !!oauthTokens,

      status:
        active?.status ||
        "IDLE",

      broadcastId:
        active?.broadcastId ||
        null,

      youtubeUrl:
        active?.broadcastId
          ? `https://www.youtube.com/watch?v=${active.broadcastId}`
          : null,

      startedAt:
        active?.startedAt ||
        null,

      logs:
        active?.logs ||
        [],
    });
  }
);

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
          SCOPES,
      });

    res.redirect(url);
  }
);

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

      const {
        tokens,
      } =
        await client.getToken(
          req.query.code
        );

      oauthTokens =
        tokens;

      log(
        "YouTube account authorized."
      );

      res.redirect("/");

    } catch (error) {
      console.error(error);

      res
        .status(500)
        .send(
          `OAuth failed: ${error.message}`
        );
    }
  }
);

app.post(
  "/api/start",
  async (req, res) => {

    if (
      active &&
      [
        "STARTING",
        "LIVE",
      ].includes(
        active.status
      )
    ) {
      return res
        .status(409)
        .json({
          error:
            "A relay is already running.",
        });
    }

    if (!oauthTokens) {
      return res
        .status(401)
        .json({
          error:
            "Authorize YouTube first.",
        });
    }

    const sourceUrl =
      String(
        req.body.sourceUrl ||
          ""
      ).trim();

    const title =
      String(
        req.body.title ||
          "LiveBridge LIVE"
      ).trim();

    const description =
      String(
        req.body.description ||
          ""
      ).trim();

    const privacy =
      [
        "public",
        "unlisted",
        "private",
      ].includes(
        req.body.privacy
      )
        ? req.body.privacy
        : "unlisted";

    if (
      !/^https?:\/\/(www\.)?live\.bilibili\.com\//i.test(
        sourceUrl
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "Enter a live.bilibili.com URL.",
        });
    }

    if (!title) {
      return res
        .status(400)
        .json({
          error:
            "Enter a title.",
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
        null,
    };

    res.json({
      ok: true,
    });

    (async () => {
      try {
        log(
          "Resolving currently-live Bilibili stream..."
        );

        const source =
          await resolveLiveStream(
            sourceUrl
          );

        log(
          "Bilibili live media URL resolved."
        );

        log(
          "Creating YouTube broadcast " +
            "and ingestion stream..."
        );

        const yt =
          await createYouTubeBroadcast(
            title,
            description,
            privacy
          );

        active.broadcastId =
          yt.broadcastId;

        active.status =
          "LIVE";

        log(
          `YouTube broadcast created: ` +
            `${yt.broadcastId}`
        );

        log(
          "Starting real-time FFmpeg relay..."
        );

        startRelay(
          source,
          yt.ingestionAddress,
          yt.streamName
        );

        setTimeout(
          () => {
            if (
              active &&
              active.status ===
                "LIVE"
            ) {
              log(
                "Maximum stream duration " +
                  "reached; stopping relay."
              );

              stopActive();
            }
          },
          MAX_STREAM_SECONDS * 1000
        );

      } catch (error) {
        log(
          `START FAILED: ${
            error.stack ||
            error.message
          }`
        );

        if (active) {
          active.status =
            "ERROR";
        }
      }
    })();
  }
);

app.post(
  "/api/stop",
  (req, res) => {
    stopActive();

    res.json({
      ok: true,
    });
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `LiveBridge listening on port ${PORT}`
    );
  }
);
