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

const OAUTH_REDIRECT =
  `${BASE_URL}/auth/youtube/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/youtube"
];

let oauthTokens = null;
let active = null;


/* =========================================================
   PATHS
========================================================= */

const ytDlpPath =
  path.join(__dirname, "yt-dlp");

const ffmpegBinaryPath =
  path.join(
    os.tmpdir(),
    "livebridge-ffmpeg"
  );


/* =========================================================
   DIRECT FFMPEG DOWNLOAD
   No tar
   No xz
   No ffmpeg-static
========================================================= */

const FFMPEG_URL =
  "https://github.com/binmgr/ffmpeg/releases/latest/download/ffmpeg-linux-amd64";


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
   DOWNLOAD FILE
   Handles GitHub redirects
========================================================= */

function downloadFile(
  url,
  destination
) {

  return new Promise(
    (resolve, reject) => {

      const file =
        fs.createWriteStream(
          destination
        );

      const request =
        https.get(
          url,
          (response) => {

            /*
             * GitHub releases normally redirect.
             */
            if (
              response.statusCode >= 300 &&
              response.statusCode < 400 &&
              response.headers.location
            ) {

              file.close();

              try {
                fs.unlinkSync(
                  destination
                );
              } catch (_) {}

              return downloadFile(
                response.headers.location,
                destination
              )
                .then(resolve)
                .catch(reject);
            }


            if (
              response.statusCode !== 200
            ) {

              file.close();

              try {
                fs.unlinkSync(
                  destination
                );
              } catch (_) {}

              reject(
                new Error(
                  `Download HTTP ${response.statusCode} from ${url}`
                )
              );

              return;
            }


            response.pipe(file);


            file.on(
              "finish",
              () => {

                file.close(
                  () => resolve()
                );
              }
            );
          }
        );


      request.on(
        "error",
        (error) => {

          file.close();

          try {
            fs.unlinkSync(
              destination
            );
          } catch (_) {}

          reject(error);
        }
      );
    }
  );
}


/* =========================================================
   ENSURE FFMPEG
   Direct binary — no archive extraction
========================================================= */

async function ensureFFmpeg() {

  /*
   * Already downloaded.
   */
  if (
    fs.existsSync(
      ffmpegBinaryPath
    )
  ) {

    fs.chmodSync(
      ffmpegBinaryPath,
      0o755
    );

    return ffmpegBinaryPath;
  }


  /*
   * This build is for Linux x86_64.
   */
  if (
    process.arch !== "x64"
  ) {

    throw new Error(
      `Unsupported CPU architecture: ${process.arch}. ` +
      `This LiveBridge FFmpeg build requires x86_64.`
    );
  }


  log(
    "Preparing standalone FFmpeg..."
  );

  log(
    `FFmpeg architecture: ${process.arch}`
  );

  log(
    "Downloading standalone FFmpeg binary..."
  );


  await downloadFile(
    FFMPEG_URL,
    ffmpegBinaryPath
  );


  /*
   * Make executable.
   */
  fs.chmodSync(
    ffmpegBinaryPath,
    0o755
  );


  log(
    `FFmpeg binary ready: ${ffmpegBinaryPath}`
  );


  return ffmpegBinaryPath;
}


/* =========================================================
   TEST FFMPEG
   This happens BEFORE YouTube broadcast creation.
========================================================= */

async function testFFmpeg(
  ffmpegPath
) {

  log(
    "Testing FFmpeg binary..."
  );


  return new Promise(
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


      let stdout = "";
      let stderr = "";


      child.stdout.on(
        "data",
        (data) => {

          stdout +=
            data.toString();
        }
      );


      child.stderr.on(
        "data",
        (data) => {

          stderr +=
            data.toString();
        }
      );


      child.on(
        "error",
        (error) => {

          reject(
            new Error(
              `FFmpeg could not start: ${error.message}`
            )
          );
        }
      );


      child.on(
        "close",
        (code, signal) => {

          if (code === 0) {

            const firstLine =
              stdout
                .split(/\r?\n/)
                .find(Boolean) ||
              "FFmpeg started successfully.";

            log(
              `FFmpeg self-test OK: ${firstLine}`
            );

            resolve();

            return;
          }


          reject(
            new Error(
              `FFmpeg self-test failed. ` +
              `code=${code} ` +
              `signal=${signal || "none"} ` +
              `${stderr.trim()}`
            )
          );
        }
      );
    }
  );
}


/* =========================================================
   YT-DLP
========================================================= */

async function ensureYtDlp() {

  if (
    fs.existsSync(
      ytDlpPath
    )
  ) {

    return ytDlpPath;
  }


  log(
    "Downloading yt-dlp standalone binary..."
  );


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


  log(
    "yt-dlp ready."
  );


  return ytDlpPath;
}


/* =========================================================
   BILIBILI LIVE URL RESOLVER
========================================================= */

async function resolveLiveUrl(
  sourceUrl
) {

  const ytdlp =
    await ensureYtDlp();


  return new Promise(
    (resolve, reject) => {

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


      log(
        "Resolving with yt-dlp..."
      );


      const child =
        spawn(
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


      let output = "";
      let errorOutput = "";


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

          errorOutput +=
            data.toString();
        }
      );


      child.on(
        "error",
        (error) => {

          reject(error);
        }
      );


      child.on(
        "close",
        (code) => {

          const urls =
            output
              .trim()
              .split(/\r?\n/)
              .map(
                (item) =>
                  item.trim()
              )
              .filter(Boolean);


          if (
            code !== 0 ||
            urls.length === 0
          ) {

            reject(
              new Error(
                `yt-dlp could not resolve the live stream. ` +
                `${errorOutput.trim()}`
              )
            );

            return;
          }


          resolve(
            urls[0]
          );
        }
      );
    }
  );
}


/* =========================================================
   YOUTUBE BROADCAST CREATION
========================================================= */

async function createYouTubeBroadcast(
  title,
  description,
  privacy
) {

  const auth =
    getOAuthClient();


  auth.setCredentials(
    oauthTokens
  );


  const youtube =
    google.youtube({
      version: "v3",
      auth
    });


  /*
   * Schedule a tiny amount into the future.
   */
  const start =
    new Date(
      Date.now() + 60 * 1000
    ).toISOString();


  /*
   * Create broadcast.
   */
  const broadcastResponse =
    await youtube.liveBroadcasts.insert({

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
              description || ""
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
    });


  const broadcast =
    broadcastResponse.data;


  /*
   * Create ingestion stream.
   */
  const streamResponse =
    await youtube.liveStreams.insert({

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
    });


  const stream =
    streamResponse.data;


  /*
   * Bind broadcast to stream.
   */
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


/* =========================================================
   START FFMPEG RELAY
========================================================= */

function startRelay(
  sourceUrl,
  ingestionUrl,
  streamName,
  ffmpegPath
) {

  /*
   * YouTube RTMPS URL.
   */
  const outputUrl =
    `${ingestionUrl}/${streamName}`;


  /*
   * Bilibili HTTP headers.
   */
  const headers =
    "Referer: https://live.bilibili.com/\r\n" +
    "User-Agent: Mozilla/5.0 " +
    "(Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 " +
    "(KHTML, like Gecko) " +
    "Chrome/140.0.0.0 Safari/537.36\r\n";


  /*
   * FFmpeg arguments.
   *
   * Source:
   * Bilibili live stream
   *
   * Output:
   * 720x1280 vertical
   * H.264
   * AAC
   * 30fps
   * RTMPS
   */
  const args = [

    "-hide_banner",

    "-loglevel",
    "info",

    "-nostdin",


    /*
     * Network timeout.
     */
    "-rw_timeout",
    "15000000",


    /*
     * Reconnect source if possible.
     */
    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_delay_max",
    "10",


    /*
     * Bilibili request headers.
     */
    "-headers",
    headers,


    /*
     * Input.
     */
    "-i",
    sourceUrl,


    /*
     * Vertical 9:16 output.
     *
     * The source keeps its aspect ratio.
     * Empty space is padded.
     */
    "-vf",
    "scale=720:1280:" +
    "force_original_aspect_ratio=decrease," +
    "pad=720:1280:(ow-iw)/2:(oh-ih)/2," +
    "format=yuv420p",


    /*
     * Video frame rate.
     */
    "-r",
    "30",


    /*
     * H.264 encoder.
     */
    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-tune",
    "zerolatency",

    "-pix_fmt",
    "yuv420p",


    /*
     * Video bitrate.
     */
    "-b:v",
    "2500k",

    "-minrate",
    "2500k",

    "-maxrate",
    "2500k",

    "-bufsize",
    "5000k",


    /*
     * 60 frames = 2 seconds at 30fps.
     */
    "-g",
    "60",

    "-keyint_min",
    "60",

    "-sc_threshold",
    "0",


    /*
     * AAC audio.
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
     * YouTube-compatible FLV/RTMPS output.
     */
    "-f",
    "flv",

    outputUrl
  ];


  log(
    `Starting FFmpeg relay: ${ffmpegPath}`
  );


  log(
    "Output: 720x1280 / H.264 / AAC / 30 FPS"
  );


  const ffmpeg =
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


  active.ffmpeg =
    ffmpeg;


  /*
   * FFmpeg stdout.
   */
  ffmpeg.stdout.on(
    "data",
    (data) => {

      const text =
        data.toString().trim();

      if (text) {

        log(
          `FFmpeg: ${text}`
        );
      }
    }
  );


  /*
   * FFmpeg stderr.
   *
   * FFmpeg normally prints most information
   * to stderr, so this is important.
   */
  ffmpeg.stderr.on(
    "data",
    (data) => {

      const text =
        data.toString().trim();

      if (text) {

        log(
          `FFmpeg: ${text}`
        );
      }
    }
  );


  /*
   * Process failed to start.
   */
  ffmpeg.on(
    "error",
    (error) => {

      log(
        `FFmpeg process error: ${error.message}`
      );


      if (active) {

        active.status =
          "ERROR";
      }
    }
  );


  /*
   * Process stopped.
   */
  ffmpeg.on(
    "close",
    (code, signal) => {

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

        active.status =
          "ENDED";

      } else {

        active.status =
          "ERROR";
      }
    }
  );


  return ffmpeg;
}


/* =========================================================
   STOP
========================================================= */

function stopActive() {

  if (!active) {
    return;
  }


  if (
    active.ffmpeg &&
    !active.ffmpeg.killed
  ) {

    try {

      active.ffmpeg.kill(
        "SIGTERM"
      );

    } catch (_) {}
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

    res.json({

      ok:
        true,

      configured:
        ensureConfig().length === 0,

      authenticated:
        !!oauthTokens,

      active:
        !!active,

      status:
        active?.status ||
        "IDLE"
    });
  }
);


/* =========================================================
   STATUS
========================================================= */

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
          `Missing environment variables: ` +
          `${missing.join(", ")}`
        );
    }


    const client =
      getOAuthClient();


    const authUrl =
      client.generateAuthUrl({

        access_type:
          "offline",

        prompt:
          "consent",

        scope:
          SCOPES
      });


    res.redirect(
      authUrl
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


      const result =
        await client.getToken(
          req.query.code
        );


      oauthTokens =
        result.tokens;


      log(
        "YouTube account authorized."
      );


      res.redirect(
        "/"
      );

    } catch (error) {

      console.error(
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

    /*
     * Prevent two simultaneous relays.
     */
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


    /*
     * YouTube must be authorized.
     */
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


    /*
     * Basic Bilibili URL validation.
     */
    if (
      !/^https?:\/\/(www\.)?live\.bilibili\.com\//i
        .test(
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


    if (!title) {

      return res
        .status(400)
        .json({

          error:
            "Enter a title."
        });
    }


    /*
     * Initialize active session.
     */
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


    /*
     * Return immediately to browser.
     */
    res.json({

      ok:
        true
    });


    /*
     * Continue asynchronously.
     */
    (async () => {

      try {

        /* -----------------------------------------
           STEP 1 — FFMPEG
        ----------------------------------------- */

        log(
          "Checking FFmpeg runtime..."
        );


        const ffmpegPath =
          await ensureFFmpeg();


        await testFFmpeg(
          ffmpegPath
        );


        /* -----------------------------------------
           STEP 2 — BILIBILI
        ----------------------------------------- */

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


        /* -----------------------------------------
           STEP 3 — YOUTUBE
        ----------------------------------------- */

        log(
          "Creating YouTube broadcast and ingestion stream..."
        );


        const youtube =
          await createYouTubeBroadcast(
            title,
            description,
            privacy
          );


        active.broadcastId =
          youtube.broadcastId;


        log(
          `YouTube broadcast created: ` +
          `${youtube.broadcastId}`
        );


        /* -----------------------------------------
           STEP 4 — FFMPEG RELAY
        ----------------------------------------- */

        active.status =
          "LIVE";


        log(
          "Starting real-time FFmpeg relay..."
        );


        startRelay(
          liveUrl,
          youtube.ingestionAddress,
          youtube.streamName,
          ffmpegPath
        );


        /* -----------------------------------------
           STEP 5 — MAXIMUM DURATION
        ----------------------------------------- */

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


      } catch (error) {

        log(
          `START FAILED: ` +
          `${error.stack || error.message}`
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
   STOP LIVE
========================================================= */

app.post(
  "/api/stop",
  (req, res) => {

    stopActive();


    res.json({

      ok:
        true
    });
  }
);


/* =========================================================
   SERVER
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
