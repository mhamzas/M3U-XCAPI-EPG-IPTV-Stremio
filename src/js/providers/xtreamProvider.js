// xtreamProvider.js
// Extended to support series (shows) via Xtream API:
// - fetchData now retrieves series list when includeSeries !== false
// - fetchSeriesInfo lazily queries per-series episodes (get_series_info)
// episodes are transformed into Stremio 'videos' (season/episode).
const fetch = require("node-fetch");
const crypto = require("crypto");
const prescanCache = require("../../../prescanCache");

async function fetchData(addonInstance) {
  const { config } = addonInstance;
  const {
    xtreamUrl,
    xtreamUsername,
    xtreamPassword,
    xtreamUseM3U,
    xtreamOutput,
  } = config;

  if (!xtreamUrl || !xtreamUsername || !xtreamPassword) {
    throw new Error("Xtream credentials incomplete");
  }

  // Preserve previous data in case the fetch fails (graceful degradation)
  const prevChannels = addonInstance.channels || [];
  const prevMovies = addonInstance.movies || [];
  const prevSeries = addonInstance.series || [];
  const prevEpg = addonInstance.epgData || {};

  addonInstance.channels = [];
  addonInstance.movies = [];
  if (config.includeSeries !== false) addonInstance.series = [];
  addonInstance.epgData = {};

  if (xtreamUseM3U) {
    // M3U plus mode (series heuristic limited)
    const url =
      `${xtreamUrl}/get.php?username=${encodeURIComponent(xtreamUsername)}` +
      `&password=${encodeURIComponent(xtreamPassword)}` +
      `&type=m3u_plus` +
      (xtreamOutput ? `&output=${encodeURIComponent(xtreamOutput)}` : "");
    const resp = await fetch(url, {
      timeout: 30000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36" },
    });
    if (!resp.ok) throw new Error("Xtream M3U fetch failed");
    const text = await resp.text();
    const items = addonInstance.parseM3U(text);

    addonInstance.channels = items.filter((i) => i.type === "tv");
    addonInstance.movies = items.filter((i) => i.type === "movie");

    if (config.includeSeries !== false) {
      const seriesCandidates = items.filter((i) => i.type === "series");
      // Reduce duplication by grouping by cleaned series name
      const seen = new Map();
      for (const sc of seriesCandidates) {
        const baseName = sc.name.replace(/\bS\d{1,2}E\d{1,2}\b.*$/i, "").trim();
        if (!seen.has(baseName)) {
          seen.set(baseName, {
            id: `iptv_series_${cryptoHash(baseName)}`,
            series_id: cryptoHash(baseName),
            name: baseName,
            type: "series",
            poster: sc.logo || sc.attributes?.["tvg-logo"],
            plot: sc.attributes?.["plot"] || "",
            category: sc.category,
            attributes: {
              "tvg-logo": sc.logo || sc.attributes?.["tvg-logo"],
              "group-title": sc.category || sc.attributes?.["group-title"],
              plot: sc.attributes?.["plot"] || "",
            },
          });
        }
      }
      addonInstance.series = Array.from(seen.values());
    }
  } else {
    // JSON API mode
    const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36" };
    const psCacheKey = prescanCache.makeKey(xtreamUrl, xtreamUsername, xtreamPassword);

    let live = [];
    let vod = [];
    let liveCatMap = {};
    let vodCatMap = {};
    let usedPrescanCache = false;

    try {
      // Fetch streams + category lists in parallel to map category_id -> category_name
      const [liveResp, vodResp, liveCatsResp, vodCatsResp] = await Promise.all([
        fetch(`${base}&action=get_live_streams`, { timeout: 30000, headers }),
        fetch(`${base}&action=get_vod_streams`, { timeout: 30000, headers }),
        fetch(`${base}&action=get_live_categories`, { timeout: 20000, headers }).catch(
          () => null,
        ),
        fetch(`${base}&action=get_vod_categories`, { timeout: 20000, headers }).catch(
          () => null,
        ),
      ]);

      if (!liveResp.ok) throw new Error(`Xtream live streams fetch failed (${liveResp.status})`);
      if (!vodResp.ok) throw new Error(`Xtream VOD streams fetch failed (${vodResp.status})`);
      live = await liveResp.json();
      vod = await vodResp.json();

      try {
        if (liveCatsResp && liveCatsResp.ok) {
          const arr = await liveCatsResp.json();
          if (Array.isArray(arr)) {
            for (const c of arr) {
              if (c && c.category_id && c.category_name)
                liveCatMap[c.category_id] = c.category_name;
            }
          }
        }
      } catch { /* ignore */ }
      try {
        if (vodCatsResp && vodCatsResp.ok) {
          const arr = await vodCatsResp.json();
          if (Array.isArray(arr)) {
            for (const c of arr) {
              if (c && c.category_id && c.category_name)
                vodCatMap[c.category_id] = c.category_name;
            }
          }
        }
      } catch { /* ignore */ }
    } catch (fetchErr) {
      // Direct API fetch failed — try prescan cache (browser-relayed data)
      const cached = prescanCache.get(psCacheKey);
      if (cached && (cached.liveStreams?.length || cached.vodStreams?.length)) {
        console.log("[XTREAM] API fetch failed, using prescan cache fallback:", fetchErr.message);
        live = cached.liveStreams || [];
        vod = cached.vodStreams || [];
        usedPrescanCache = true;
      } else if (prevChannels.length || prevMovies.length) {
        // Restore previous data if we had some
        console.log("[XTREAM] API fetch failed, restoring previous data:", fetchErr.message);
        addonInstance.channels = prevChannels;
        addonInstance.movies = prevMovies;
        addonInstance.series = prevSeries;
        addonInstance.epgData = prevEpg;
        return; // Exit without further processing
      } else {
        throw fetchErr; // No fallback available
      }
    }

    addonInstance.channels = (Array.isArray(live) ? live : []).map((s) => {
      const cat =
        liveCatMap[s.category_id] || s.category_name || s.category_id || "Live";
      return {
        id: `iptv_live_${s.stream_id}`,
        name: s.name,
        type: "tv",
        url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.m3u8`,
        logo: s.stream_icon,
        category: cat,
        epg_channel_id: s.epg_channel_id,
        attributes: {
          "tvg-logo": s.stream_icon,
          "tvg-id": s.epg_channel_id,
          "group-title": cat,
        },
      };
    });

    addonInstance.movies = (Array.isArray(vod) ? vod : []).map((s) => {
      const cat = vodCatMap[s.category_id] || s.category_name || "Movies";
      return {
        id: `iptv_vod_${s.stream_id}`,
        name: s.name,
        type: "movie",
        url: `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.${s.container_extension}`,
        poster: s.stream_icon,
        plot: s.plot,
        year: s.releasedate ? new Date(s.releasedate).getFullYear() : null,
        category: cat,
        attributes: {
          "tvg-logo": s.stream_icon,
          "group-title": cat,
          plot: s.plot,
        },
      };
    });

    if (config.includeSeries !== false) {
      let seriesData = null;
      // If prescan cache had series data, use it directly
      if (usedPrescanCache) {
        const cached = prescanCache.get(psCacheKey);
        if (cached && Array.isArray(cached.seriesStreams)) {
          seriesData = cached.seriesStreams;
        }
      }
      if (!seriesData) {
        try {
          const [seriesResp, seriesCatsResp] = await Promise.all([
            fetch(`${base}&action=get_series`, { timeout: 35000, headers }),
            fetch(`${base}&action=get_series_categories`, {
              timeout: 20000,
              headers,
            }).catch(() => null),
          ]);
          let seriesCatMap = {};
          try {
            if (seriesCatsResp && seriesCatsResp.ok) {
              const arr = await seriesCatsResp.json();
              if (Array.isArray(arr)) {
                for (const c of arr) {
                  if (c && c.category_id && c.category_name)
                    seriesCatMap[c.category_id] = c.category_name;
                }
              }
            }
          } catch {
            /* ignore */
          }
          if (seriesResp.ok) {
            const seriesList = await seriesResp.json();
            if (Array.isArray(seriesList)) {
              addonInstance.series = seriesList.map((s) => {
                const cat =
                  seriesCatMap[s.category_id] || s.category_name || "Series";
                return {
                  id: `iptv_series_${s.series_id}`,
                  series_id: s.series_id,
                  name: s.name,
                  type: "series",
                  poster: s.cover,
                  plot: s.plot,
                  category: cat,
                  attributes: {
                    "tvg-logo": s.cover,
                    "group-title": cat,
                    plot: s.plot,
                  },
                };
              });
            }
          }
        } catch (e) {
          // Series fetch optional – check prescan cache
          const cached = prescanCache.get(psCacheKey);
          if (cached && Array.isArray(cached.seriesStreams)) {
            seriesData = cached.seriesStreams;
          }
        }
      }
      // Apply pre-processed series data from prescan cache
      if (seriesData && Array.isArray(seriesData)) {
        addonInstance.series = seriesData.map((s) => ({
          id: `iptv_series_${s.series_id}`,
          series_id: s.series_id,
          name: s.name,
          type: "series",
          poster: s.cover,
          plot: s.plot,
          category: s.category_name || "Series",
          attributes: {
            "tvg-logo": s.cover,
            "group-title": s.category_name || "Series",
            plot: s.plot,
          },
        }));
      }
    }
  }

  // EPG handling:
  if (config.enableEpg) {
    const customEpgUrl =
      config.epgUrl && typeof config.epgUrl === "string" && config.epgUrl.trim()
        ? config.epgUrl.trim()
        : null;
    const epgSource = customEpgUrl
      ? customEpgUrl
      : `${xtreamUrl}/xmltv.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;

    try {
      const epgResp = await fetch(epgSource, {
        timeout: 45000,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36" },
      });
      if (epgResp.ok) {
        const epgContent = await epgResp.text();
        addonInstance.epgData = await addonInstance.parseEPG(epgContent);
      }
    } catch {
      // Ignore EPG errors
    }
  }
}

async function fetchSeriesInfo(addonInstance, seriesId) {
  // For xtream JSON API only
  const { config } = addonInstance;
  if (!seriesId) return { videos: [] };
  if (
    !config ||
    !config.xtreamUrl ||
    !config.xtreamUsername ||
    !config.xtreamPassword
  )
    return { videos: [] };

  const base = `${config.xtreamUrl}/player_api.php?username=${encodeURIComponent(config.xtreamUsername)}&password=${encodeURIComponent(config.xtreamPassword)}`;
  try {
    const infoResp = await fetch(
      `${base}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`,
      {
        timeout: 25000,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36" },
      },
    );
    if (!infoResp.ok) return { videos: [] };
    const infoJson = await infoResp.json();
    const videos = [];
    // Xtream returns episodes keyed by season: { "1": [ { id, title, container_extension, episode_num, season, ...}, ... ], "2": [...] }
    const episodesObj = infoJson.episodes || {};
    Object.keys(episodesObj).forEach((seasonKey) => {
      const seasonEpisodes = episodesObj[seasonKey];
      if (Array.isArray(seasonEpisodes)) {
        for (const ep of seasonEpisodes) {
          const epId = ep.id;
          const container = ep.container_extension || "mp4";
          const url = `${config.xtreamUrl}/series/${encodeURIComponent(config.xtreamUsername)}/${encodeURIComponent(config.xtreamPassword)}/${epId}.${container}`;
          // Convert released date to ISO 8601 format
          let releasedRaw = ep.releasedate || ep.added || null;
          let releasedISO = null;
          if (releasedRaw) {
            releasedRaw = String(releasedRaw).trim();
            // Unix timestamp (all digits)
            if (/^\d{9,13}$/.test(releasedRaw)) {
              const ts =
                releasedRaw.length <= 10
                  ? parseInt(releasedRaw, 10) * 1000
                  : parseInt(releasedRaw, 10);
              const d = new Date(ts);
              if (!isNaN(d.getTime())) releasedISO = d.toISOString();
            } else {
              // Try parsing as date string
              const d = new Date(releasedRaw);
              if (!isNaN(d.getTime())) releasedISO = d.toISOString();
            }
          }

          videos.push({
            id: `iptv_series_ep_${epId}`,
            title: ep.title || `Episode ${ep.episode_num}`,
            season: parseInt(ep.season || seasonKey, 10),
            episode: parseInt(ep.episode_num || ep.episode || 0, 10),
            released: releasedISO,
            thumbnail:
              ep.info?.movie_image ||
              ep.info?.episode_image ||
              ep.info?.cover_big ||
              null,
            url,
            stream_id: epId,
          });
        }
      }
    });
    // Sort by season then episode
    videos.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return { videos, fetchedAt: Date.now() };
  } catch {
    return { videos: [] };
  }
}

function cryptoHash(text) {
  return require("crypto")
    .createHash("md5")
    .update(text)
    .digest("hex")
    .slice(0, 12);
}

module.exports = {
  fetchData,
  fetchSeriesInfo,
};
