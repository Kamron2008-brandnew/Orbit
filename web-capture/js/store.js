// IndexedDB storage. Frames are written as they are captured, so a scan survives Safari reloading the tab.
//   scans: { id, name, createdAt, status, mode, heightM, frames: [...meta], coverage, stats, score, thumb: Blob }
//   files: { scanId, name, blob }   key [scanId, name]

const DB_NAME = "orbit";
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("scans", { keyPath: "id" });
      const files = db.createObjectStore("files", { keyPath: ["scanId", "name"] });
      files.createIndex("scan", "scanId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const result = fn(t);
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const putScan = scan => tx("scans", "readwrite", t => { t.objectStore("scans").put(scan); });
export const putFile = (scanId, name, blob) => tx("files", "readwrite", t => { t.objectStore("files").put({ scanId, name, blob }); });

export async function getScan(id) {
  const db = await open();
  return reqP(db.transaction("scans").objectStore("scans").get(id));
}

export async function listScans() {
  const db = await open();
  const all = await reqP(db.transaction("scans").objectStore("scans").getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getFile(scanId, name) {
  const db = await open();
  return reqP(db.transaction("files").objectStore("files").get([scanId, name]));
}

export async function getFiles(scanId) {
  const db = await open();
  return reqP(db.transaction("files").objectStore("files").index("scan").getAll(scanId));
}

export async function deleteScan(id) {
  const db = await open();
  const keys = await reqP(db.transaction("files").objectStore("files").index("scan").getAllKeys(id));
  return tx(["scans", "files"], "readwrite", t => {
    t.objectStore("scans").delete(id);
    const fs = t.objectStore("files");
    for (const k of keys) fs.delete(k);
  });
}

export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
