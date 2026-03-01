// prescanCache.js – Shared prescan data cache
// Browser uploads fetched Xtream/M3U data here so the server-side provider
// can use it when the IPTV provider blocks server IPs.
const crypto = require("crypto");
const LRUCache = require("./lruCache");

const cache = new LRUCache({ max: 20, ttl: 4 * 3600 * 1000 }); // 4 hour TTL

function makeKey(url, username, password) {
  return crypto
    .createHash("md5")
    .update(`${url}|${username}|${password}`)
    .digest("hex");
}

module.exports = {
  set(key, data) {
    cache.set(key, data);
  },
  get(key) {
    return cache.get(key);
  },
  makeKey,
};
