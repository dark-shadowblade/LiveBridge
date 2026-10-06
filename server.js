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

const BASE_URL =
  (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

const CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || "";

const CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || "";

const MAX_STREAM_SECONDS = Math.max(
  60,
  Number(process.env.MAX_STREAM_SECONDS || 21600)
);

const OAUTH_REDIRECT =
  `${BASE_URL}/auth/youtube/callback`;

/*
 * IMPORTANT:
 * youtube = YouTube API
 * openid/email/profile = Google account information
 */
const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "openid",
  "email",
  "profile"
];


/* =========================================================
   FILES
========================================================= */

const ACCOUNTS_FILE =
  path.join(__dirname, "accounts.json");

const ytDlpPath =
  path.join(__dirname, "yt-dlp");

const ffmpegBinaryPath =
  path.join(
    os.tmpdir(),
    "livebridge-ffmpeg"
  );


/* =========================================================
   FFMPEG
========================================================= */

const FFMPEG_URL =
  "https://github.com/binmgr/ffmpeg/releases/latest/download/ffmpeg-linux-amd64";


/* =========================================================
   RUNTIME
========================================================= */

let accounts = {};

let active = null;


/* =========================================================
   USER AGENT
========================================================= */

const USER_AGENT =
  "Mozilla/5.0 " +
  "(X11; Linux x86_64) " +
  "AppleWebKit/537.36 " +
  "(KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36";


/* =========================================================
   LOAD ACCOUNTS
========================================================= */

function loadAccounts() {

  try {

    if (
      fs.existsSync(
        ACCOUNTS_FILE
      )
    ) {

      const data =
        fs.readFileSync(
          ACCOUNTS_FILE,
          "utf8"
        );

      accounts =
        JSON.parse(data);

      if (
        !accounts ||
        typeof accounts !== "object"
      ) {

        accounts = {};
      }

    } else {

      accounts = {};
    }

  } catch (error) {

    console.error(
      "Could not load accounts:",
      error
    );

    accounts = {};
  }
}

loadAccounts();


/* =========================================================
   SAVE ACCOUNTS
========================================================= */

function saveAccounts() {

  const temp =
    `${ACCOUNTS_FILE}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(
      accounts,
      null,
      2
    ),
    {
      mode: 0o600
    }
  );

  fs.renameSync(
    temp,
    ACCOUNTS_FILE
  );
}


/* =========================================================
   COOKIES
========================================================= */

function parseCookies(req) {

  const header =
    req.headers.cookie || "";

  const result = {};

  for (
    const part of header.split(";")
  ) {

    const index =
      part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      part.slice(
        0,
        index
      ).trim();

    const value =
      part.slice(
        index + 1
      ).trim();

    if (!key) {
      continue;
    }

    result[key] =
      decodeURIComponent(value);
  }

  return result;
}


function setAccountCookie(
  res,
  accountId
) {

  res.setHeader(
    "Set-Cookie",
    [
      `lb_account=${encodeURIComponent(accountId)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=31536000"
    ].join("; ")
  );
}


function clearAccountCookie(
  res
) {

  res.setHeader(
    "Set-Cookie",
    [
      "lb_account=",
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0"
    ].join("; ")
  );
}


/* =========================================================
   CURRENT ACCOUNT
========================================================= */

function getCurrentAccountId(
  req
) {

  const cookies =
    parseCookies(req);

  const selected =
    cookies.lb_account;

  if (
    selected &&
    accounts[selected]
  ) {

    return selected;
  }

  const first =
    Object.keys(accounts)[0];

  return first || null;
}


/* =========================================================
   LOG
========================================================= */

function log(message) {

  const line =
    `[${new Date().toISOString()}] ${message}`;

  console.log(line);

  if (active) {

    active.logs.push(line);

    if (
      active.logs.length > 300
    ) {

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
    missing.push(
      "PUBLIC_BASE_URL"
    );
  }

  if (!CLIENT_ID) {
    missing.push(
      "GOOGLE_CLIENT_ID"
    );
  }

  if (!CLIENT_SECRET) {
    missing.push(
      "GOOGLE_CLIENT_SECRET"
    );
  }

  return missing;
}


/* =========================================================
   GOOGLE OAUTH CLIENT
========================================================= */

function getOAuthClient() {

  return new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    OAUTH_REDIRECT
  );
}


/* =========================================================
   DOWNLOAD
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
          {
            headers: {
              "User-Agent":
                USER_AGENT
            }
          },
          (response) => {

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
                new URL(
                  response.headers.location,
                  url
                ).toString(),
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
                  `Download HTTP ${response.statusCode}`
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
   FFMPEG
========================================================= */

async function ensureFFmpeg() {

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


  if (
    process.arch !== "x64"
  ) {

    throw new Error(
      `Unsupported CPU architecture: ${process.arch}`
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
   FFMPEG TEST
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

          if (
            code === 0
          ) {

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


  await downloadFile(
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
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
   BILIBILI RESOLVE WITH YT-DLP
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
        `User-Agent: ${USER_AGENT}`,

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
        reject
      );


      child.on(
        "close",
        (code) => {

          const urls =
            output
              .trim()
              .split(/\r?\n/)
              .map(
                (x) =>
                  x.trim()
              )
              .filter(Boolean);


          if (
            code !== 0 ||
            !urls.length
          ) {

            reject(
              new Error(
                `yt-dlp could not resolve the live stream. ` +
                `${errorOutput.trim()}`
              )
            );

            return;
          }


          resolve({

            url:
              urls[0],

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
   JSON HTTP
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
          (response) => {

            let body = "";

            response.setEncoding(
              "utf8"
            );


            response.on(
              "data",
              (chunk) => {

                body +=
                  chunk;
              }
            );


            response.on(
              "end",
              () => {

                if (
                  response.statusCode < 200 ||
                  response.statusCode >= 300
                ) {

                  reject(
                    new Error(
                      `HTTP ${response.statusCode}`
                    )
                  );

                  return;
                }


                try {

                  resolve(
                    JSON.parse(
                      body
                    )
                  );

                } catch {

                  reject(
                    new Error(
                      "Invalid JSON response."
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
   BILIBILI API FALLBACK
========================================================= */

async function resolveWithBilibiliApi(
  sourceUrl
) {

  const roomId =
    getRoomId(
      sourceUrl
    );


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
      `https://api.live.bilibili.com/room/v1/Room/get_info?id=${encodeURIComponent(roomId)}`,
      {
        Referer:
          sourceUrl
      }
    );


  if (
    room.code !== 0
  ) {

    throw new Error(
      room.message ||
      "Bilibili room API error."
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
      result.data
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
      const format of formats
    ) {

      const codecs =
        format.codec || [];


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
            (item) =>
              item.host &&
              codec.base_url
          );


        if (!urlInfo) {
          continue;
        }


        const directUrl =
          `${urlInfo.host}` +
          `${codec.base_url}` +
          `${urlInfo.extra || ""}`;


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
   RESOLVE STREAM
========================================================= */

async function resolveLiveStream(
  sourceUrl
) {

  try {

    return await resolveLiveUrl(
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
   GET YOUTUBE ACCOUNT INFO
   FIXED VERSION
========================================================= */

async function getAccountInfo(
  tokens
) {

  const auth =
    getOAuthClient();


  auth.setCredentials(
    tokens
  );


  /*
   * Use YouTube API first.
   * This does NOT depend on userinfo.
   */
  const youtube =
    google.youtube({

      version:
        "v3",

      auth
    });


  const channelResponse =
    await youtube.channels.list({

      part:
        "id,snippet",

      mine:
        true
    });


  const channels =
    channelResponse.data.items ||
    [];


  if (
    !channels.length
  ) {

    throw new Error(
      "Google authorization succeeded, but no YouTube channel was found for this account."
    );
  }


  const channel =
    channels[0];


  /*
   * Default information comes from YouTube.
   */
  let email = "";

  let name =
    channel.snippet?.title ||
    "YouTube account";

  let picture =
    channel.snippet
      ?.thumbnails
      ?.default
      ?.url ||
    null;


  /*
   * Google profile lookup is optional.
   *
   * If it fails, OAuth still succeeds.
   */
  try {

    const oauth2 =
      google.oauth2({

        auth,

        version:
          "v2"
      });


    const userResponse =
      await oauth2.userinfo.get();


    const user =
      userResponse.data;


    email =
      user.email ||
      "";

    name =
      user.name ||
      name;

    picture =
      user.picture ||
      picture;

  } catch (error) {

    console.log(
      "Google profile lookup skipped:",
      error.message
    );
  }


  return {

    /*
     * YouTube channel ID is the
     * stable LiveBridge account ID.
     */
    id:
      channel.id,

    email,

    name,

    picture,

    channels:
      channels.map(
        (item) => ({

          id:
            item.id,

          title:
            item.snippet
              ?.title ||
            "YouTube channel",

          thumbnail:
            item.snippet
              ?.thumbnails
              ?.default
              ?.url ||
            null
        })
      )
  };
}


/* =========================================================
   SAVE ACCOUNT
========================================================= */

async function saveOAuthAccount(
  tokens
) {

  const info =
    await getAccountInfo(
      tokens
    );


  const accountId =
    info.id;


  const existing =
    accounts[accountId] ||
    {};


  accounts[accountId] = {

    id:
      accountId,

    email:
      info.email,

    name:
      info.name,

    picture:
      info.picture,

    channels:
      info.channels,

    tokens: {

      /*
       * Preserve old refresh token if Google
       * doesn't send a new one.
       */
      ...existing.tokens,

      ...tokens
    },

    updatedAt:
      new Date().toISOString()
  };


  saveAccounts();


  return accounts[accountId];
}


/* =========================================================
   AUTH CLIENT FOR SAVED ACCOUNT
========================================================= */

function getAuthForAccount(
  accountId
) {

  const account =
    accounts[accountId];


  if (!account) {

    throw new Error(
      "YouTube account not found."
    );
  }


  const auth =
    getOAuthClient();


  auth.setCredentials(
    account.tokens
  );


  /*
   * Save refreshed access token.
   */
  auth.on(
    "tokens",
    (newTokens) => {

      if (
        accounts[accountId]
      ) {

        accounts[accountId].tokens =
          {
            ...accounts[accountId].tokens,
            ...newTokens
          };


        accounts[accountId].updatedAt =
          new Date().toISOString();


        try {

          saveAccounts();

        } catch (error) {

          console.error(
            "Could not save refreshed token:",
            error
          );
        }
      }
    }
  );


  return auth;
}


/* =========================================================
   YOUTUBE BROADCAST
========================================================= */

async function createYouTubeBroadcast(
  accountId,
  title,
  description,
  privacy
) {

  const auth =
    getAuthForAccount(
      accountId
    );


  const youtube =
    google.youtube({

      version:
        "v3",

      auth
    });


  const start =
    new Date(
      Date.now() + 60 * 1000
    ).toISOString();


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
   FFMPEG RELAY
========================================================= */

function startRelay(
  source,
  ingestionUrl,
  streamName,
  ffmpegPath
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


    "-i",
    source.url,


    /*
     * 9:16 vertical.
     */
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

    const accountId =
      getCurrentAccountId(
        req
      );


    res.json({

      ok:
        true,

      configured:
        ensureConfig().length === 0,

      authenticated:
        !!accountId,

      active:
        !!active,

      status:
        active?.status ||
        "IDLE"
    });
  }
);


/* =========================================================
   ACCOUNTS
========================================================= */

app.get(
  "/api/accounts",
  (req, res) => {

    const currentId =
      getCurrentAccountId(
        req
      );


    const list =
      Object.values(
        accounts
      ).map(
        (account) => ({

          id:
            account.id,

          email:
            account.email,

          name:
            account.name,

          picture:
            account.picture,

          channels:
            account.channels ||
            []
        })
      );


    res.json({

      accounts:
        list,

      currentAccountId:
        currentId
    });
  }
);


/* =========================================================
   SELECT ACCOUNT
========================================================= */

app.post(
  "/api/accounts/select",
  (req, res) => {

    const accountId =
      String(
        req.body.accountId ||
        ""
      ).trim();


    if (
      !accountId ||
      !accounts[accountId]
    ) {

      return res
        .status(404)
        .json({

          error:
            "YouTube account not found."
        });
    }


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
            "Stop the current LIVE before switching accounts."
        });
    }


    setAccountCookie(
      res,
      accountId
    );


    res.json({

      ok:
        true,

      accountId
    });
  }
);


/* =========================================================
   REMOVE ACCOUNT
========================================================= */

app.post(
  "/api/accounts/remove",
  (req, res) => {

    const accountId =
      String(
        req.body.accountId ||
        ""
      ).trim();


    if (
      !accountId ||
      !accounts[accountId]
    ) {

      return res
        .status(404)
        .json({

          error:
            "YouTube account not found."
        });
    }


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
            "Stop the current LIVE before removing an account."
        });
    }


    delete accounts[
      accountId
    ];


    saveAccounts();


    const cookies =
      parseCookies(
        req
      );


    if (
      cookies.lb_account ===
      accountId
    ) {

      clearAccountCookie(
        res
      );
    }


    res.json({

      ok:
        true
    });
  }
);


/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status",
  (req, res) => {

    const accountId =
      getCurrentAccountId(
        req
      );


    const account =
      accountId
        ? accounts[accountId]
        : null;


    if (
      accountId &&
      parseCookies(req).lb_account !==
        accountId
    ) {

      setAccountCookie(
        res,
        accountId
      );
    }


    res.json({

      authenticated:
        !!account,

      currentAccount:
        account
          ? {

              id:
                account.id,

              email:
                account.email,

              name:
                account.name,

              picture:
                account.picture,

              channels:
                account.channels ||
                []
            }
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
   OAUTH START
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


    /*
     * Always show Google account chooser.
     */
    const url =
      client.generateAuthUrl({

        access_type:
          "offline",

        prompt:
          "select_account consent",

        scope:
          SCOPES
      });


    res.redirect(
      url
    );
  }
);


/* =========================================================
   OAUTH CALLBACK
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


      const tokens =
        result.tokens;


      /*
       * Identify the YouTube channel.
       */
      const account =
        await saveOAuthAccount(
          tokens
        );


      /*
       * Automatically select the
       * newly-added account.
       */
      setAccountCookie(
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


    const accountId =
      getCurrentAccountId(
        req
      );


    if (
      !accountId ||
      !accounts[accountId]
    ) {

      return res
        .status(401)
        .json({

          error:
            "Select or authorize a YouTube account first."
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

      accountId
    };


    res.json({

      ok:
        true
    });


    (async () => {

      try {

        log(
          `Using YouTube account: ${
            accounts[accountId].email ||
            accounts[accountId].name
          }`
        );


        /*
         * FFmpeg first.
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
         * Bilibili.
         */
        log(
          "Resolving currently-live Bilibili stream..."
        );


        const liveStream =
          await resolveLiveStream(
            sourceUrl
          );


        log(
          "Bilibili live media URL resolved."
        );


        /*
         * YouTube.
         */
        log(
          "Creating YouTube broadcast and ingestion stream..."
        );


        const youtube =
          await createYouTubeBroadcast(

            accountId,

            title,

            description,

            privacy
          );


        active.broadcastId =
          youtube.broadcastId;


        log(
          `YouTube broadcast created: ${
            youtube.broadcastId
          }`
        );


        /*
         * Relay.
         */
        active.status =
          "LIVE";


        log(
          "Starting real-time FFmpeg relay..."
        );


        startRelay(

          liveStream,

          youtube.ingestionAddress,

          youtube.streamName,

          ffmpegPath
        );


        /*
         * Maximum duration.
         */
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


/* =========================================================
   STOP
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
