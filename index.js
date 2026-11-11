const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const TMDB_KEY = process.env.TMDB_API_KEY;
if (!TMDB_KEY) throw new Error("Set the TMDB_API_KEY environment variable");

const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const PAGE_SIZE = 20; // TMDB returns 20 results per page
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const cache = new Map();

// ---------- Date helpers ----------
const isoDate = (d) => d.toISOString().slice(0, 10);
const today = () => isoDate(new Date());
const daysAgo = (n) => isoDate(new Date(Date.now() - n * 24 * 60 * 60 * 1000));

// ---------- TMDB client with in-memory cache ----------
async function tmdb(path, params = {}) {
  const url = new URL(TMDB + path);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", "en-US");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL) return hit.data;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} on ${path}`);
  const data = await res.json();
  cache.set(key, { data, time: Date.now() });
  return data;
}

// ---------- Catalog definitions ----------
const CATALOGS = {
  india_popular_movie: {
    type: "movie",
    path: "/discover/movie",
    params: () => ({
      with_origin_country: "IN",
      sort_by: "popularity.desc",
      "vote_count.gte": 10,
      include_adult: false,
    }),
  },
  india_new_movie: {
    type: "movie",
    path: "/discover/movie",
    params: () => ({
      with_origin_country: "IN",
      sort_by: "primary_release_date.desc",
      "primary_release_date.gte": daysAgo(90),
      "primary_release_date.lte": today(),
      include_adult: false,
    }),
  },
  india_popular_series: {
    type: "series",
    path: "/discover/tv",
    params: () => ({
      with_origin_country: "IN",
      sort_by: "popularity.desc",
      "vote_count.gte": 10,
    }),
  },
  india_new_series: {
    type: "series",
    path: "/discover/tv",
    params: () => ({
      with_origin_country: "IN",
      sort_by: "first_air_date.desc",
      "first_air_date.gte": daysAgo(365),
      "first_air_date.lte": today(),
    }),
  },
};

// ---------- Manifest ----------
const manifest = {
  id: "community.tmdb.india.catalog",
  version: "1.0.0",
  name: "India Catalog (TMDB)",
  description: "Popular and new Indian movies and TV shows, powered by TMDB.",
  logo: "https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  idPrefixes: ["tmdb"],
  catalogs: [
    {
      type: "movie",
      id: "india_popular_movie",
      name: "Popular in India",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "movie",
      id: "india_new_movie",
      name: "New Releases in India",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "india_popular_series",
      name: "Popular in India",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "india_new_series",
      name: "New Releases in India",
      extra: [{ name: "skip", isRequired: false }],
    },
  ],
};

const builder = new addonBuilder(manifest);

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

// ---------- Catalog handler ----------
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const cfg = CATALOGS[id];
  if (!cfg || cfg.type !== type) return { metas: [] };

  try {
    const skip = parseInt(extra?.skip ?? 0, 10) || 0;
    const page = Math.min(500, Math.floor(skip / PAGE_SIZE) + 1); // TMDB caps at 500 pages

    const data = await tmdb(cfg.path, { ...cfg.params(), page });
    return { metas: data.results.map((r) => toMeta(r, type)) };
  } catch (err) {
    console.error(`Catalog ${id} failed:`, err.message);
    return { metas: [] };
  }
});

// ---------- Meta handler (details + episodes for series) ----------
builder.defineMetaHandler(async ({ type, id }) => {
  const tmdbId = id.replace(/^tmdb:/, "");

  try {
    if (type === "movie") {
      const m = await tmdb(`/movie/${tmdbId}`);
      return { meta: toMeta(m, "movie") };
    }

    // Series: fetch show, then each season for episode list
    const show = await tmdb(`/tv/${tmdbId}`);
    const seasons = (show.seasons || []).filter((s) => s.season_number > 0);
    const seasonData = await Promise.all(
      seasons.map((s) => tmdb(`/tv/${tmdbId}/season/${s.season_number}`))
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
  } catch (err) {
    console.error(`Meta ${id} failed:`, err.message);
    return { meta: null };
  }
});

// ---------- Start server ----------
serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
console.log("India Catalog addon running on port", process.env.PORT || 7000);
