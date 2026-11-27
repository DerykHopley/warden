// A Map kept in memory with a cap on its keys: a key is added as the newest entry, and past the cap the oldest (the
// first added) is forgotten. A Map keeps its keys in the order they were added, so the first key is the oldest.

/** Sets `key` to `value` as the map's newest entry, first forgetting its oldest when it holds `maxKeys` already. */
export function setNewest<K, V>(map: Map<K, V>, key: K, value: V, maxKeys: number): void {
  map.delete(key);
  if (map.size >= maxKeys) {
    const oldest = map.keys().next();
    if (oldest.done !== true) map.delete(oldest.value);
  }
  map.set(key, value);
}
