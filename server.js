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

const PORT = Number(process.env.PORT || 5000);
const BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

const MAX_STREAM_SECONDS = Math.max(
  60,
  Number(process.env.MAX_STREAM_SECONDS || 21600)
);

const OAUTH_REDIRECT =
  `${BASE_URL}/auth/youtube/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "openid",
  "email",
  "profile"
];

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const accountsPath =
  path.join(__dirname, "accounts.json");

const ytDlpPath =
  path.join(os.tmpdir(), "livebridge-yt-dlp");

const ffmpegPath =
  path.join(os.tmpdir(), "livebridge-ffmpeg");

const caBundlePath =
  path.join(os.tmpdir(), "livebridge-ca-bundle.pem");

let active = null;


/* =========================================================
   LOGGING
========================================================= */

function log(message) {
  const line =
    `[${new Date().toISOString()}] ${message}`;

  console.log(line);

  if (active) {
    active.logs.push(line);

    if (active.logs.length > 300) {
      active.logs.shift();
    }
  }
}


/* =========================================================
   CONFIG
========================================================= */

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


/* =========================================================
   GOOGLE OAUTH
========================================================= */

function getOAuthClient() {
  return new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    OAUTH_REDIRECT
  );
}


/* =========================================================
   ACCOUNT STORAGE
========================================================= */

function loadAccounts() {
  try {
    if (!fs.existsSync(accountsPath)) {
      return {};
    }

    const data =
      JSON.parse(
        fs.readFileSync(
          accountsPath,
          "utf8"
        )
      );

    return data &&
      typeof data === "object"
      ? data
      : {};

  } catch (error) {
    console.error(
      "Could not read accounts.json:",
      error.message
    );

    return {};
  }
}


function saveAccounts(accounts) {
  fs.writeFileSync(
    accountsPath,
    JSON.stringify(
      accounts,
      null,
      2
    ),
    {
      mode: 0o600
    }
  );
}


/* =========================================================
   COOKIE HELPERS
========================================================= */

function parseCookies(req) {
  const result = {};

  const raw =
    req.headers.cookie || "";

  for (
    const part of raw.split(";")
  ) {
    const index =
      part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      part.slice(0, index).trim();

    const value =
      part.slice(index + 1).trim();

    if (key) {
      result[key] =
        decodeURIComponent(value);
    }
  }

  return result;
}


function getSelectedAccountId(req) {
  const cookies =
    parseCookies(req);

  const accounts =
    loadAccounts();

  const ids =
    Object.keys(accounts);

  if (
    cookies.lb_account &&
    accounts[cookies.lb_account]
  ) {
    return cookies.lb_account;
  }

  return ids.length
    ? ids[0]
    : null;
}


function setSelectedAccount(
  res,
  accountId
) {
  res.setHeader(
    "Set-Cookie",
    `lb_account=${encodeURIComponent(
      accountId
    )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
  );
}


function clearSelectedAccount(res) {
  res.setHeader(
    "Set-Cookie",
    "lb_account=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
}


/* =========================================================
   SAFE ACCOUNT OBJECT
========================================================= */

function sanitizeAccount(account) {
  return {
    id: account.id,

    channelId:
      account.channelId ||
      account.id,

    email:
      account.email ||
      "",

    name:
      account.name ||
      "YouTube channel",

    picture:
      account.picture ||
      "",

    channels:
      Array.isArray(account.channels)
        ? account.channels
        : []
  };
}


/* =========================================================
   GENERIC HTTPS DOWNLOAD
========================================================= */

function downloadFile(
  url,
  destination,
  redirectCount = 0
) {
  if (redirectCount > 10) {
    return Promise.reject(
      new Error(
        "Too many download redirects."
      )
    );
  }

  return new Promise(
    (resolve, reject) => {
      const file =
        fs.createWriteStream(
          destination
        );

      const request =
        https.get(
          url,
          {
            headers: {
              "User-Agent":
                USER_AGENT,

              Accept:
                "*/*"
            }
          },

          (res) => {
            if (
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              file.close();

              fs.unlink(
                destination,
                () => {}
              );

              return downloadFile(
                new URL(
                  res.headers.location,
                  url
                ).toString(),

                destination,

                redirectCount + 1
              ).then(
                resolve,
                reject
              );
            }

            if (
              res.statusCode !== 200
            ) {
              file.close();

              fs.unlink(
                destination,
                () => {}
              );

              return reject(
                new Error(
                  `Download HTTP ${res.statusCode} from ${url}`
                )
              );
            }

            res.pipe(file);

            file.on(
              "finish",
              () => {
                file.close(resolve);
              }
            );
          }
        );

      request.on(
        "error",
        (error) => {
          file.close();

          fs.unlink(
            destination,
            () => {}
          );

          reject(error);
        }
      );

      file.on(
        "error",
        (error) => {
          request.destroy();

          fs.unlink(
            destination,
            () => {}
          );

          reject(error);
        }
      );
    }
  );
}


/* =========================================================
   FILE CHECK
========================================================= */

function isUsableFile(
  filePath,
  minimumBytes = 1024
) {
  try {
    return (
      fs.existsSync(filePath) &&
      fs.statSync(filePath).size >=
        minimumBytes
    );
  } catch {
    return false;
  }
}


/* =========================================================
   YT-DLP
========================================================= */

async function ensureYtDlp() {
  if (
    isUsableFile(
      ytDlpPath,
      1024 * 1024
    )
  ) {
    return ytDlpPath;
  }

  log(
    "Downloading yt-dlp standalone binary..."
  );

  const url =
    "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux";

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


/* =========================================================
   CA CERTIFICATE BUNDLE
========================================================= */

function findSystemCABundle() {
  const candidates = [
    process.env.SSL_CERT_FILE,

    "/etc/ssl/certs/ca-certificates.crt",

    "/etc/ssl/cert.pem",

    "/etc/pki/tls/certs/ca-bundle.crt",

    "/etc/ssl/certs/ca-bundle.crt",

    "/etc/pki/tls/cacert.pem"
  ].filter(Boolean);

  for (
    const candidate of candidates
  ) {
    try {
      if (
        !fs.existsSync(candidate)
      ) {
        continue;
      }

      const stat =
        fs.statSync(candidate);

      if (
        stat.isFile() &&
        stat.size > 10000
      ) {
        return candidate;
      }

    } catch {}
  }

  return null;
}


async function ensureCABundle() {
  const systemBundle =
    findSystemCABundle();

  if (systemBundle) {
    log(
      `Using system CA bundle: ${systemBundle}`
    );

    return systemBundle;
  }

  if (
    isUsableFile(
      caBundlePath,
      10000
    )
  ) {
    log(
      `Using cached CA bundle: ${caBundlePath}`
    );

    return caBundlePath;
  }

  log(
    "No usable system CA bundle found."
  );

  log(
    "Downloading Mozilla CA bundle..."
  );

  await downloadFile(
    "https://curl.se/ca/cacert.pem",
    caBundlePath
  );

  const content =
    fs.readFileSync(
      caBundlePath,
      "utf8"
    );

  if (
    content.length < 10000 ||
    !content.includes(
      "-----BEGIN CERTIFICATE-----"
    )
  ) {
    fs.unlinkSync(
      caBundlePath
    );

    throw new Error(
      "Downloaded CA bundle is invalid."
    );
  }

  log(
    `CA bundle ready: ${caBundlePath}`
  );

  return caBundlePath;
}


/* =========================================================
   FFMPEG
========================================================= */

async function ensureFFmpeg() {
  if (
    isUsableFile(
      ffmpegPath,
      1024 * 1024
    )
  ) {
    return ffmpegPath;
  }

  log(
    "Preparing standalone FFmpeg..."
  );

  log(
    `FFmpeg architecture: ${process.arch}`
  );

  if (
    process.arch !== "x64"
  ) {
    throw new Error(
      `Unsupported runtime architecture: ${process.arch}`
    );
  }

  log(
    "Downloading standalone FFmpeg binary..."
  );

  await downloadFile(
    "https://github.com/binmgr/ffmpeg/releases/latest/download/ffmpeg-linux-amd64",
    ffmpegPath
  );

  fs.chmodSync(
    ffmpegPath,
    0o755
  );

  log(
    `FFmpeg binary ready: ${ffmpegPath}`
  );

  log(
    "Testing FFmpeg binary..."
  );

  await new Promise(
    (resolve, reject) => {
      const child =
        spawn(
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

      child.stdout.on(
        "data",
        (data) => {
          output +=
            data.toString();
        }
      );

      child.stderr.on(
        "data",
        (data) => {
          output +=
            data.toString();
        }
      );

      child.on(
        "error",
        reject
      );

      child.on(
        "close",
        (code) => {
          if (code !== 0) {
            return reject(
              new Error(
                `FFmpeg self-test failed with code ${code}.`
              )
            );
          }

          const versionLine =
            output
              .split(/\r?\n/)
              .find(
                (line) =>
                  line.startsWith(
                    "ffmpeg version"
                  )
              );

          log(
            `FFmpeg self-test OK: ${
              versionLine || "OK"
            }`
          );

          resolve();
        }
      );
    }
  );

  return ffmpegPath;
}


/* =========================================================
   HTTP JSON
========================================================= */

function httpGetJson(
  url,
  headers = {}
) {
  return new Promise(
    (resolve, reject) => {
      const request =
        https.get(
          url,
          {
            headers: {
              "User-Agent":
                USER_AGENT,

              Accept:
                "application/json, text/plain, */*",

              ...headers
            }
          },

          (res) => {
            let body = "";

            res.setEncoding(
              "utf8"
            );

            res.on(
              "data",
              (chunk) => {
                body += chunk;
              }
            );

            res.on(
              "end",
              () => {
                if (
                  res.statusCode < 200 ||
                  res.statusCode >= 300
                ) {
                  return reject(
                    new Error(
                      `HTTP ${res.statusCode}: ${body.slice(
                        0,
                        500
                      )}`
                    )
                  );
                }

                try {
                  resolve(
                    JSON.parse(body)
                  );
                } catch {
                  reject(
                    new Error(
                      `Invalid JSON from ${url}`
                    )
                  );
                }
              }
            );
          }
        );

      request.on(
        "error",
        reject
      );
    }
  );
}


/* =========================================================
   FFMPEG LOGGING
========================================================= */

function spawnLogged(
  command,
  args,
  options = {}
) {
  const child =
    spawn(
      command,
      args,
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ],
        ...options
      }
    );

  child.stdout.on(
    "data",
    (data) => {
      const text =
        String(data).trim();

      if (text) {
        log(
          `FFmpeg: ${text}`
        );
      }
    }
  );

  child.stderr.on(
    "data",
    (data) => {
      const text =
        String(data).trim();

      if (text) {
        log(
          `FFmpeg: ${text}`
        );
      }
    }
  );

  return child;
}


/* =========================================================
   BILIBILI ROOM ID
========================================================= */

function getRoomId(
  sourceUrl
) {
  const match =
    sourceUrl.match(
      /live\.bilibili\.com\/(?:blanc\/)?(\d+)/i
    );

  return match
    ? match[1]
    : null;
}


/* =========================================================
   YT-DLP BILIBILI RESOLVER
========================================================= */

async function resolveWithYtDlp(
  sourceUrl
) {
  const ytdlp =
    await ensureYtDlp();

  return new Promise(
    (resolve, reject) => {
      const args = [
        "--no-warnings",
        "--no-playlist",
        "-f",
        "best",
        "-g",
        sourceUrl
      ];

      const child =
        spawn(
          ytdlp,
          args,
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe"
            ],

            env: {
              ...process.env,

              LANG:
                "C.UTF-8",

              LC_ALL:
                "C.UTF-8"
            }
          }
        );

      let out = "";
      let err = "";

      child.stdout.on(
        "data",
        (data) => {
          out +=
            data.toString();
        }
      );

      child.stderr.on(
        "data",
        (data) => {
          err +=
            data.toString();
        }
      );

      child.on(
        "error",
        reject
      );

      child.on(
        "close",
        (code) => {
          const urls =
            out
              .trim()
              .split(/\r?\n/)
              .map(
                (x) => x.trim()
              )
              .filter(Boolean);

          if (
            code !== 0 ||
            !urls.length
          ) {
            return reject(
              new Error(
                `yt-dlp could not resolve the live stream. ${err.trim()}`
              )
            );
          }

          resolve({
            url: urls[0],

            headers: {
              Referer:
                sourceUrl,

              "User-Agent":
                USER_AGENT
            }
          });
        }
      );
    }
  );
}


/* =========================================================
   BILIBILI API FALLBACK
========================================================= */

async function resolveWithBilibiliApi(
  sourceUrl
) {
  const roomId =
    getRoomId(sourceUrl);

  if (!roomId) {
    throw new Error(
      "Could not extract Bilibili room ID."
    );
  }

  log(
    `Trying Bilibili live API fallback for room ${roomId}...`
  );

  const room =
    await httpGetJson(
      `https://api.live.bilibili.com/room/v1/Room/get_info?id=${encodeURIComponent(
        roomId
      )}`,
      {
        Referer:
          sourceUrl
      }
    );

  if (room.code !== 0) {
    throw new Error(
      room.message ||
        `Bilibili room API error ${room.code}`
    );
  }

  const roomData =
    room.data || {};

  if (
    Number(
      roomData.live_status
    ) !== 1
  ) {
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
    80
  ];

  for (
    const qn of qualities
  ) {
    const params =
      new URLSearchParams({
        room_id:
          roomId,

        qn:
          String(qn),

        codec:
          "0,1",

        format:
          "0,2",

        mask:
          "0",

        no_playurl:
          "0",

        platform:
          "web",

        protocol:
          "0,1"
      });

    const result =
      await httpGetJson(
        `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?${params}`,
        {
          Referer:
            sourceUrl
        }
      );

    if (
      result.code !== 0
    ) {
      continue;
    }

    const streams =
      result
        .data
        ?.playurl_info
        ?.playurl
        ?.stream ||
      [];

    const formats =
      streams.flatMap(
        (stream) =>
          stream.format || []
      );

    for (
      const fmt of formats
    ) {
      const codecs =
        fmt.codec || [];

      for (
        const codec of codecs
      ) {
        if (
          Number(
            codec.current_qn
          ) !== qn
        ) {
          continue;
        }

        const urlInfo =
          (
            codec.url_info ||
            []
          ).find(
            (x) =>
              x.host &&
              codec.base_url &&
              x.extra !== undefined
          );

        if (!urlInfo) {
          continue;
        }

        const directUrl =
          `${urlInfo.host}` +
          `${codec.base_url}` +
          `${urlInfo.extra}`;

        log(
          `Bilibili API resolved ${qn} quality.`
        );

        return {
          url:
            directUrl,

          headers: {
            Referer:
              sourceUrl,

            "User-Agent":
              USER_AGENT
          }
        };
      }
    }
  }

  throw new Error(
    "Bilibili API returned no playable stream URLs."
  );
}


/* =========================================================
   RESOLVE LIVE STREAM
========================================================= */

async function resolveLiveStream(
  sourceUrl
) {
  try {
    log(
      "Resolving with yt-dlp..."
    );

    return await resolveWithYtDlp(
      sourceUrl
    );

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


/* =========================================================
   YOUTUBE ACCOUNT INFO
========================================================= */

async function getAccountInfo(
  tokens
) {
  const auth =
    getOAuthClient();

  auth.setCredentials(
    tokens
  );

  const youtube =
    google.youtube({
      version:
        "v3",

      auth
    });

  const channelsResponse =
    await youtube.channels.list({
      part:
        "id,snippet",

      mine:
        true,

      maxResults:
        50
    });

  const channels =
    channelsResponse
      .data
      .items || [];

  if (!channels.length) {
    throw new Error(
      "This Google account has no YouTube channel available."
    );
  }

  let email = "";

  let name =
    channels[0]
      .snippet
      ?.title ||
    "YouTube channel";

  let picture =
    channels[0]
      .snippet
      ?.thumbnails
      ?.default
      ?.url ||
    "";

  try {
    const oauth2 =
      google.oauth2({
        version:
          "v2",

        auth
      });

    const profile =
      await oauth2.userinfo.get();

    email =
      profile.data.email ||
      email;

    name =
      profile.data.name ||
      name;

    picture =
      profile.data.picture ||
      picture;

  } catch (error) {
    console.log(
      "Google profile lookup skipped:",
      error.message
    );
  }

  return {
    id:
      channels[0].id,

    channelId:
      channels[0].id,

    email,

    name,

    picture,

    channels:
      channels.map(
        (channel) => ({
          id:
            channel.id,

          title:
            channel
              .snippet
              ?.title ||
            "YouTube channel",

          picture:
            channel
              .snippet
              ?.thumbnails
              ?.default
              ?.url ||
            ""
        })
      ),

    tokens
  };
}


/* =========================================================
   SELECTED ACCOUNT
========================================================= */

async function getSelectedAccount(
  req
) {
  const accounts =
    loadAccounts();

  const id =
    getSelectedAccountId(req);

  if (
    !id ||
    !accounts[id]
  ) {
    return null;
  }

  return accounts[id];
}


/* =========================================================
   CREATE YOUTUBE BROADCAST
========================================================= */

async function createYouTubeBroadcast(
  account,
  title,
  description,
  privacy
) {
  const auth =
    getOAuthClient();

  auth.setCredentials(
    account.tokens
  );

  const youtube =
    google.youtube({
      version:
        "v3",

      auth
    });

  const start =
    new Date(
      Date.now() + 60_000
    ).toISOString();

  const broadcastResponse =
    await youtube.liveBroadcasts.insert(
      {
        part:
          "snippet,status,contentDetails",

        requestBody: {
          snippet: {
            title:
              title.slice(
                0,
                100
              ),

            description:
              (
                description ||
                ""
              ).slice(
                0,
                5000
              ),

            scheduledStartTime:
              start,

            categoryId:
              "24"
          },

          status: {
            privacyStatus:
              privacy
          },

          contentDetails: {
            enableAutoStart:
              true,

            enableAutoStop:
              true,

            recordFromStart:
              true,

            enableDvr:
              true
          }
        }
      }
    );

  const broadcast =
    broadcastResponse.data;

  const streamResponse =
    await youtube.liveStreams.insert(
      {
        part:
          "snippet,cdn,contentDetails",

        requestBody: {
          snippet: {
            title:
              `${title.slice(
                0,
                90
              )} - LiveBridge`
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
            isReusable:
              false
          }
        }
      }
    );

  const stream =
    streamResponse.data;

  await youtube.liveBroadcasts.bind(
    {
      part:
        "id,snippet,contentDetails,status",

      id:
        broadcast.id,

      streamId:
        stream.id
    }
  );

  return {
    youtube,

    broadcastId:
      broadcast.id,

    streamId:
      stream.id,

    ingestionAddress:
      stream
        .cdn
        .ingestionInfo
        .rtmpsIngestionAddress,

    streamName:
      stream
        .cdn
        .ingestionInfo
        .streamName
  };
}


/* =========================================================
   START FFMPEG REAL-TIME RELAY
========================================================= */

function startRelay(
  source,
  ingestionUrl,
  streamName,
  ffmpegExecutable,
  caPath
) {
  const outputUrl =
    `${ingestionUrl}/${streamName}`;

  const headers =
    source.headers || {};

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

    "-user_agent",
    headers["User-Agent"] ||
      USER_AGENT,

    "-headers",
    `Referer: ${
      headers.Referer ||
      "https://live.bilibili.com/"
    }\r\n`,

    /*
      IMPORTANT:
      Keep certificate verification ON.
      The CA bundle fixes FFmpeg's missing
      certificate trust-store problem.
    */

    "-tls_verify",
    "1",

    "-ca_file",
    caPath,

    "-i",
    source.url,

    /*
      9:16 vertical output
    */

    "-vf",
    "scale=720:1280:force_original_aspect_ratio=decrease," +
      "pad=720:1280:(ow-iw)/2:(oh-ih)/2," +
      "format=yuv420p",

    "-r",
    "30",

    /*
      Video
    */

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

    /*
      2 second GOP
    */

    "-g",
    "60",

    "-keyint_min",
    "60",

    "-sc_threshold",
    "0",

    /*
      Audio
    */

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-ar",
    "44100",

    "-ac",
    "2",

    /*
      YouTube RTMPS
    */

    "-f",
    "flv",

    "-tls_verify",
    "1",
    "-ca_file",
    caPath,

    outputUrl
  ];

  log(
    `Starting FFmpeg relay: ${ffmpegExecutable}`
  );

  log(
    `Using CA bundle: ${caPath}`
  );

  log(
    "Output: 720x1280 / H.264 / AAC / 30 FPS"
  );

  const ff =
    spawnLogged(
      ffmpegExecutable,
      args
    );

  if (active) {
    active.ffmpeg = ff;
  }

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
    (error) => {
      log(
        `FFmpeg error: ${error.message}`
      );

      if (active) {
        active.status =
          "ERROR";
      }
    }
  );

  return ff;
}


/* =========================================================
   STOP ACTIVE RELAY
========================================================= */

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

  active.status =
    "STOPPED";
}


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (req, res) => {
    const accounts =
      loadAccounts();

    res.json({
      ok:
        true,

      configured:
        ensureConfig()
          .length === 0,

      accounts:
        Object.keys(accounts)
          .length,

      active:
        !!active,

      status:
        active?.status ||
        "IDLE"
    });
  }
);


/* =========================================================
   ACCOUNTS API
========================================================= */

app.get(
  "/api/accounts",
  (req, res) => {
    const accounts =
      loadAccounts();

    const selectedId =
      getSelectedAccountId(req);

    res.json({
      accounts:
        Object.values(accounts)
          .map(
            sanitizeAccount
          ),

      selectedId
    });
  }
);


app.post(
  "/api/accounts/select",
  (req, res) => {
    const id =
      String(
        req.body.id ||
          ""
      ).trim();

    const accounts =
      loadAccounts();

    if (
      !id ||
      !accounts[id]
    ) {
      return res
        .status(404)
        .json({
          error:
            "YouTube account not found."
        });
    }

    setSelectedAccount(
      res,
      id
    );

    res.json({
      ok:
        true,

      selectedId:
        id,

      account:
        sanitizeAccount(
          accounts[id]
        )
    });
  }
);


app.post(
  "/api/accounts/remove",
  (req, res) => {
    const id =
      String(
        req.body.id ||
          ""
      ).trim();

    const accounts =
      loadAccounts();

    if (
      !id ||
      !accounts[id]
    ) {
      return res
        .status(404)
        .json({
          error:
            "YouTube account not found."
        });
    }

    delete accounts[id];

    saveAccounts(
      accounts
    );

    const remainingIds =
      Object.keys(accounts);

    if (
      remainingIds.length
    ) {
      setSelectedAccount(
        res,
        remainingIds[0]
      );
    } else {
      clearSelectedAccount(
        res
      );
    }

    res.json({
      ok:
        true,

      selectedId:
        remainingIds[0] ||
        null
    });
  }
);


/* =========================================================
   STATUS API
========================================================= */

app.get(
  "/api/status",
  (req, res) => {
    const accounts =
      loadAccounts();

    const selectedId =
      getSelectedAccountId(req);

    res.json({
      authenticated:
        Object.keys(accounts)
          .length > 0,

      selectedId,

      selectedAccount:
        selectedId &&
        accounts[selectedId]
          ? sanitizeAccount(
              accounts[selectedId]
            )
          : null,

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
        []
    });
  }
);


/* =========================================================
   YOUTUBE OAUTH START
========================================================= */

app.get(
  "/auth/youtube/start",
  (req, res) => {
    const missing =
      ensureConfig();

    if (
      missing.length
    ) {
      return res
        .status(500)
        .send(
          `Missing environment variables: ${missing.join(
            ", "
          )}`
        );
    }

    const client =
      getOAuthClient();

    const url =
      client.generateAuthUrl(
        {
          access_type:
            "offline",

          prompt:
            "select_account consent",

          scope:
            SCOPES
        }
      );

    res.redirect(
      url
    );
  }
);


/* =========================================================
   YOUTUBE OAUTH CALLBACK
========================================================= */

app.get(
  "/auth/youtube/callback",
  async (req, res) => {
    try {
      if (
        !req.query.code
      ) {
        return res
          .status(400)
          .send(
            "Missing OAuth code."
          );
      }

      const client =
        getOAuthClient();

      const {
        tokens
      } =
        await client.getToken(
          req.query.code
        );

      const account =
        await getAccountInfo(
          tokens
        );

      const accounts =
        loadAccounts();

      const existing =
        accounts[
          account.id
        ];

      /*
        Preserve refresh token if Google
        does not send a new one.
      */

      if (
        existing?.tokens
          ?.refresh_token &&
        !account.tokens
          .refresh_token
      ) {
        account.tokens
          .refresh_token =
          existing.tokens
            .refresh_token;
      }

      accounts[
        account.id
      ] = account;

      saveAccounts(
        accounts
      );

      setSelectedAccount(
        res,
        account.id
      );

      console.log(
        `YouTube account authorized: ${
          account.email ||
          account.name
        }`
      );

      res.redirect(
        "/"
      );

    } catch (error) {
      console.error(
        "OAuth callback failed:",
        error
      );

      res
        .status(500)
        .send(
          `OAuth failed: ${error.message}`
        );
    }
  }
);


/* =========================================================
   START LIVE
========================================================= */

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

    const account =
      await getSelectedAccount(
        req
      );

    if (!account) {
      return res
        .status(401)
        .json({
          error:
            "Add/authorize a YouTube account first."
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
        "private"
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
            "Enter a live.bilibili.com URL."
        });
    }

    if (
      !getRoomId(
        sourceUrl
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "Enter a Bilibili room URL with a numeric room ID, for example https://live.bilibili.com/21156534"
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
        new Date()
          .toISOString(),

      ffmpeg:
        null,

      broadcastId:
        null,

      accountId:
        account.id,

      stopTimer:
        null
    };

    log(
      `Using YouTube account: ${
        account.email ||
        account.name
      }`
    );

    /*
      Respond immediately to browser.
      Relay continues in background.
    */

    res.json({
      ok:
        true
    });

    (async () => {
      try {

        /*
          FFmpeg
        */

        log(
          "Checking FFmpeg runtime..."
        );

        const ffmpegExecutable =
          await ensureFFmpeg();

        /*
          CA certificate fix
        */

        const caPath =
          await ensureCABundle();

        /*
          Bilibili
        */

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

        /*
          YouTube
        */

        log(
          "Creating YouTube broadcast and ingestion stream..."
        );

        const yt =
          await createYouTubeBroadcast(
            account,
            title,
            description,
            privacy
          );

        if (!active) {
          return;
        }

        active.broadcastId =
          yt.broadcastId;

        active.status =
          "LIVE";

        log(
          `YouTube broadcast created: ${yt.broadcastId}`
        );

        /*
          Real-time FFmpeg relay
        */

        log(
          "Starting real-time FFmpeg relay..."
        );

        startRelay(
          source,

          yt.ingestionAddress,

          yt.streamName,

          ffmpegExecutable,

          caPath
        );

        /*
          Maximum stream duration
        */

        active.stopTimer =
          setTimeout(
            () => {

              if (
                active &&
                active.status ===
                  "LIVE"
              ) {
                log(
                  "Maximum stream duration reached; stopping relay."
                );

                stopActive();
              }

            },

            MAX_STREAM_SECONDS *
              1000
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


/* =========================================================
   STOP
========================================================= */

app.post(
  "/api/stop",
  (req, res) => {

    if (
      active?.stopTimer
    ) {
      clearTimeout(
        active.stopTimer
      );

      active.stopTimer =
        null;
    }

    stopActive();

    res.json({
      ok:
        true
    });
  }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `LiveBridge listening on port ${PORT}`
    );
  }
);
