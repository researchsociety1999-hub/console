// Encrypted local vault: AES-256-GCM via Web Crypto, keyed by a
// passphrase-derived PBKDF2 key. Stores history/console events in
// IndexedDB. No plaintext telemetry history is written unencrypted.

const DB_NAME = "console-vault";
const STORE_NAME = "records";
const PBKDF2_ITERATIONS = 100000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export class Vault {
  constructor() {
    this._key = null;
    this._salt = null;
  }

  get isUnlocked() { return !!this._key; }

  async unlock(passphrase) {
    let saltHex = localStorage.getItem("console-vault-salt");
    if (!saltHex) {
      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      saltHex = Array.from(saltBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("console-vault-salt", saltHex);
    }
    const salt = new Uint8Array(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
    this._salt = salt;
    this._key = await deriveKey(passphrase, salt);
  }

  lock() {
    this._key = null;
  }

  async store(record) {
    if (!this._key) throw new Error("Vault is locked");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify(record));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this._key, plaintext);

    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).add({
        iv: Array.from(iv),
        ciphertext: Array.from(new Uint8Array(ciphertext)),
        createdAt: Date.now()
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async exportAll() {
    if (!this._key) throw new Error("Vault is locked");
    const db = await openDb();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const decoder = new TextDecoder();
    const results = [];
    for (const row of rows) {
      const iv = new Uint8Array(row.iv);
      const ciphertext = new Uint8Array(row.ciphertext);
      try {
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, this._key, ciphertext);
        results.push(JSON.parse(decoder.decode(plaintext)));
      } catch {
        // Skip records that fail to decrypt under the current key.
      }
    }
    return results;
  }

  async clearAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearRecentRecords(maxAgeMs = 5 * 60 * 1000) {
    const db = await openDb();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    const cutoff = Date.now() - maxAgeMs;
    const staleIds = rows
      .filter((row) => typeof row.createdAt === "number" && row.createdAt >= cutoff)
      .map((row) => row.id);

    if (!staleIds.length) return true;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      staleIds.forEach((id) => store.delete(id));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearCurrentSensorSnapshot() {
    localStorage.removeItem("console-current-sensor-data");
    return true;
  }
}
