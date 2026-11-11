const express = require("express");

// ---------- Server settings ----------
const PORT = process.env.PORT || 7000;
// Optional fallback key. If set in Render, the default /manifest.json works without configuration.
const SERVER_TMDB_KEY = (process.env.TMDB_API_KEY || "").trim();

const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const PAGE_SIZE = 20;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const cache = new Map();

// Languages offered on the configure page
const LANGUAGES = [
  ["en-US", "English"],
  ["hi-IN", "Hindi"],
  ["ta-IN", "Tamil"],
  ["te-IN", "Telugu"],
  ["ml-IN", "Malayalam"],
  ["kn-IN", "Kannada"],
  ["bn-IN", "Bengali"],
  ["mr-IN", "Marathi"],
  ["gu-IN", "Gujarati"],
  ["pa-IN", "Punjabi"],
];

// Default user settings. To add a new setting later, add it here,
// read it in settingsFrom(), and add a field to configurePage().
const DEFAULT_SETTINGS = {
  tmdbKey: "",
  language: "en-US",
  newMovieDays: 90,
  newSeriesDays: 365,
};

// ---------- Helpers ----------
const isoDate = (d) => d.toISOString().slice(0, 10);
const today = () => isoDate(new Date());
const daysAgo = (n) => isoDate(new Date(Date.now() - n * 86400000));

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Settings travel inside the URL as a base64url-encoded JSON string
function encodeConfig(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function decodeConfig(str) {
  try {
    const value = JSON.parse(Buffer.from(str, "base64url").toString("utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

// Combine the settings from the URL with the defaults
function settingsFrom(configParam) {
  const c = configParam ? decodeConfig(configParam) : {};
  return {
    tmdbKey: String(c.tmdbKey || SERVER_TMDB_KEY).trim(),
    language: String(c.language || DEFAULT_SETTINGS.language),
    newMovieDays: clampInt(c.newMovieDays, DEFAULT_SETTINGS.newMovieDays, 1, 3650),
    newSeriesDays: clampInt(c.newSeriesDays, DEFAULT_SETTINGS.newSeriesDays, 1, 3650),
  };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function baseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

// ---------- TMDB client with cache ----------
async function tmdb(s, path, params = {}) {
  if (!s.tmdbKey) throw new Error("No TMDB API key configured");

  const url = new URL(TMDB + path);
  url.searchParams.set("api_key", s.tmdbKey);
  url.searchParams.set("language", s.language);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL) return hit.data;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} on ${path}`); // no key in error message
  const data = await res.json();
  cache.set(key, { data, time: Date.now() });
  return data;
}

// ---------- Catalog definitions ----------
function catalogDefs(s) {
  return {
    india_popular_movie: {
      type: "movie",
      path: "/discover/movie",
      params: {
        with_origin_country: "IN",
        sort_by: "popularity.desc",
        "vote_count.gte": 10,
        include_adult: false,
      },
    },
    india_new_movie: {
      type: "movie",
      path: "/discover/movie",
      params: {
        with_origin_country: "IN",
        sort_by: "primary_release_date.desc",
        "primary_release_date.gte": daysAgo(s.newMovieDays),
        "primary_release_date.lte": today(),
        include_adult: false,
      },
    },
    india_popular_series: {
      type: "series",
      path: "/discover/tv",
      params: {
        with_origin_country: "IN",
        sort_by: "popularity.desc",
        "vote_count.gte": 10,
      },
    },
    india_new_series: {
      type: "series",
      path: "/discover/tv",
      params: {
        with_origin_country: "IN",
        sort_by: "first_air_date.desc",
        "first_air_date.gte": daysAgo(s.newSeriesDays),
        "first_air_date.lte": today(),
      },
    },
  };
}

// ---------- Manifest ----------
function buildManifest() {
  return {
    id: "community.tmdb.india.catalog",
    version: "1.1.0",
    name: "India Catalog (TMDB)",
    description: "Popular and new Indian movies and TV shows, powered by TMDB.",
    logo: "https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg",
    resources: ["catalog", "meta"],
    types: ["movie", "series"],
    idPrefixes: ["tmdb"],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
    catalogs: [
      { type: "movie", id: "india_popular_movie", name: "Popular in India", extra: [{ name: "skip", isRequired: false }] },
      { type: "movie", id: "india_new_movie", name: "New Releases in India", extra: [{ name: "skip", isRequired: false }] },
      { type: "series", id: "india_popular_series", name: "Popular in India", extra: [{ name: "skip", isRequired: false }] },
      { type: "series", id: "india_new_series", name: "New Releases in India", extra: [{ name: "skip", isRequired: false }] },
    ],
  };
}

// ---------- Mapping ----------
function toMeta(item, type) {
  return {
    id: `tmdb:${item.id}`,
    type,
    name: item.title || item.name,
    poster: item.poster_path ? `${IMG}/w500${item.poster_path}` : undefined,
    background: item.backdrop_path ? `${IMG}/original${item.backdrop_path}` : undefined,
    description: item.overview || undefined,
    releaseInfo: (item.release_date || item.first_air_date || "").slice(0, 4) || undefined,
    genres: item.genres ? item.genres.map((g) => g.name) : undefined,
  };
}

// ---------- Handlers ----------
async function getCatalog(s, type, id, extra) {
  const def = catalogDefs(s)[id];
  if (!def || def.type !== type) return { metas: [] };

  const skip = parseInt(extra.skip || "0", 10) || 0;
  const page = Math.min(500, Math.floor(skip / PAGE_SIZE) + 1); // TMDB caps at 500 pages

  const data = await tmdb(s, def.path, { ...def.params, page });
  return { metas: data.results.map((r) => toMeta(r, type)) };
}

async function getMeta(s, type, id) {
  const tmdbId = id.replace(/^tmdb:/, "");

  if (type === "movie") {
    const m = await tmdb(s, `/movie/${tmdbId}`);
    return { meta: toMeta(m, "movie") };
  }

  // Series: fetch show, then each season for the episode list
  const show = await tmdb(s, `/tv/${tmdbId}`);
  const seasons = (show.seasons || []).filter((x) => x.season_number > 0);
  const seasonData = await Promise.all(
    seasons.map((x) => tmdb(s, `/tv/${tmdbId}/season/${x.season_number}`))
  );

  const videos = seasonData.flatMap((sd) =>
    (sd.episodes || []).map((ep) => ({
      id: `tmdb:${tmdbId}:${ep.season_number}:${ep.episode_number}`,
      title: ep.name,
      season: ep.season_number,
      episode: ep.episode_number,
      released: ep.air_date ? new Date(ep.air_date).toISOString() : undefined,
      thumbnail: ep.still_path ? `${IMG}/w300${ep.still_path}` : undefined,
      overview: ep.overview || undefined,
    }))
  );

  return { meta: { ...toMeta(show, "series"), videos } };
}

// ---------- Pages ----------
const pageStyle = `
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e8e8e8;
         margin: 0; padding: 40px 20px; display: flex; justify-content: center; }
  .card { max-width: 640px; width: 100%; background: #1a1d24; border-radius: 12px; padding: 32px; }
  h1 { margin-top: 0; font-size: 1.8em; }
  p, li { line-height: 1.5; color: #c8ccd4; }
  a.btn, button { display: inline-block; background: #7b5cff; color: #fff; border: 0; border-radius: 8px;
                  padding: 10px 18px; font-size: 1em; text-decoration: none; cursor: pointer; margin: 6px 6px 6px 0; }
  a.btn.secondary, button.secondary { background: #353a45; }
  label { display: block; margin-top: 16px; font-weight: 600; }
  input, select { width: 100%; box-sizing: border-box; padding: 10px; margin-top: 6px; border-radius: 8px;
                  border: 1px solid #3a3f4b; background: #0f1115; color: #e8e8e8; font-size: 1em; }
  small { color: #8a909c; }
  .ok { color: #6fd38f; } .warn { color: #f0b657; }
  #result { display: none; margin-top: 24px; padding: 16px; background: #0f1115; border-radius: 8px; }
  code { word-break: break-all; font-size: 0.9em; }
`;

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${pageStyle}</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

function homePage(base) {
  const ready = Boolean(SERVER_TMDB_KEY);
  return layout("India Catalog for Stremio", `
    <h1>India Catalog for Stremio</h1>
    <p>Popular and new Indian movies and TV shows, shown as catalogs in Stremio. Data comes from TMDB.</p>
    <ul>
      <li>Popular in India (movies and series)</li>
      <li>New Releases in India (movies and series)</li>
    </ul>
    <p class="${ready ? "ok" : "warn"}">
      ${ready
        ? "The server has a default TMDB key, so you can install the addon right away."
        : "No default TMDB key is set. Click Configure and enter your own TMDB API key first."}
    </p>
    <a class="btn" href="/configure">Configure &amp; get install link</a>
    ${ready ? `<a class="btn secondary" href="/manifest.json">Default manifest</a>` : ""}
    <p><small>Your addon base address: <code>${escapeHtml(base)}</code></small></p>
  `);
}

function configurePage(existing) {
  const prefill = JSON.stringify({
    tmdbKey: existing.tmdbKey || "",
    language: existing.language || DEFAULT_SETTINGS.language,
    newMovieDays: existing.newMovieDays || DEFAULT_SETTINGS.newMovieDays,
    newSeriesDays: existing.newSeriesDays || DEFAULT_SETTINGS.newSeriesDays,
  }).replace(/</g, "\\u003c");

  const options = LANGUAGES
    .map(([code, name]) => `<option value="${code}">${escapeHtml(name)} (${code})</option>`)
    .join("");

  return layout("Configure India Catalog", `
    <h1>Configure India Catalog</h1>
    <p>Enter your settings, click <b>Generate</b>, then install the link in Stremio.</p>

    <form id="cfg">
      <label>TMDB API key
        <input name="tmdbKey" type="text" placeholder="Paste your TMDB API Key (v3)" autocomplete="off">
        <small>Get one free at themoviedb.org → Settings → API. Leave empty to use the server's default key, if one is set.</small>
      </label>

      <label>Language for titles and descriptions
        <select name="language">${options}</select>
      </label>

      <label>"New movies" window (days)
        <input name="newMovieDays" type="number" min="1" max="3650" value="90">
      </label>

      <label>"New series" window (days)
        <input name="newSeriesDays" type="number" min="1" max="3650" value="365">
      </label>

      <button type="submit">Generate install link</button>
    </form>

    <div id="result">
      <p><b>Your install link:</b></p>
      <input id="url" type="text" readonly onclick="this.select()">
      <p>
        <a id="install" class="btn" target="_blank" rel="noopener">Open in Stremio Web</a>
        <button type="button" class="secondary" id="copy">Copy link</button>
      </p>
      <p><small>In the Stremio desktop or mobile app, go to Addons, paste this link into the search box, and click Install. Anyone with this link can use your TMDB key, so only share it with people you trust.</small></p>
    </div>

    <p><a class="btn secondary" href="/">← Back to home</a></p>

    <script>
      var prefill = ${prefill};
      var form = document.getElementById("cfg");
      ["tmdbKey", "language", "newMovieDays", "newSeriesDays"].forEach(function (k) {
        if (prefill[k] !== undefined && prefill[k] !== "") form.elements[k].value = prefill[k];
      });

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var cfg = {
          tmdbKey: form.elements.tmdbKey.value.trim(),
          language: form.elements.language.value,
          newMovieDays: Number(form.elements.newMovieDays.value),
          newSeriesDays: Number(form.elements.newSeriesDays.value)
        };
        // base64url encoding (URL-safe version of base64)
        var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))))
          .replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
        var manifest = location.origin + "/" + b64 + "/manifest.json";
        document.getElementById("url").value = manifest;
        document.getElementById("install").href =
          "https://web.stremio.com/#/addons?addon=" + encodeURIComponent(manifest);
        document.getElementById("result").style.display = "block";
      });

      document.getElementById("copy").addEventListener("click", function () {
        var box = document.getElementById("url");
        box.select();
        navigator.clipboard.writeText(box.value);
        this.textContent = "Copied!";
      });
    </script>
  `);
}

// ---------- Server ----------
const app = express();
app.set("trust proxy", true); // needed so https links work behind Render's proxy

// Stremio Web needs CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

// Homepage
app.get("/", (req, res) => {
  res.type("html").send(homePage(baseUrl(req)));
});

// Configuration page (also reachable from Stremio's "Configure" button)
app.get(["/configure", "/:config/configure"], (req, res) => {
  const existing = req.params.config ? decodeConfig(req.params.config) : {};
  res.type("html").send(configurePage(existing));
});

// Manifest
app.get(["/manifest.json", "/:config/manifest.json"], (req, res) => {
  res.json(buildManifest());
});

// Catalogs
app.get(
  [
    "/catalog/:type/:id.json",
    "/catalog/:type/:id/:extra.json",
    "/:config/catalog/:type/:id.json",
    "/:config/catalog/:type/:id/:extra.json",
  ],
  async (req, res) => {
    const s = settingsFrom(req.params.config);
    const extra = Object.fromEntries(new URLSearchParams(req.params.extra || ""));
    try {
      res.json(await getCatalog(s, req.params.type, req.params.id, extra));
    } catch (err) {
      console.error(`Catalog ${req.params.id} failed:`, err.message);
      res.json({ metas: [] });
    }
  }
);

// Metadata
app.get(["/meta/:type/:id.json", "/:config/meta/:type/:id.json"], async (req, res) => {
  const s = settingsFrom(req.params.config);
  try {
    res.json(await getMeta(s, req.params.type, req.params.id));
  } catch (err) {
    console.error(`Meta ${req.params.id} failed:`, err.message);
    res.json({ meta: null });
  }
});

app.listen(PORT, () => {
  console.log("India Catalog addon running on port", PORT);
});
