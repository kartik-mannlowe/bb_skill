"use strict";
// Writes ~/.bb/config.json in exactly the shape bb.py's loader reads (bbclient/config.py):
// url, api_key, api_secret, obtained_via, saved_at, user, and for a per-client credential
// auth_source, credential, expires_on. Never the password. Directory 0700, file 0600, written to a
// private temp file and renamed into place, so a crash cannot leave a half-written or readable file.
const fs = require("fs");
const path = require("path");

function readConfig(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch { return {}; }
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = fs.statSync(dir).mode & 0o777;
  if (mode & 0o077) fs.chmodSync(dir, 0o700);
}

function localIso(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function writeConfig(file, { url, creds, user }) {
  const data = { url, api_key: creds.api_key, api_secret: creds.api_secret, obtained_via: "login",
                 saved_at: localIso(), user };
  if (creds.auth_source) Object.assign(data, { auth_source: creds.auth_source, credential: creds.credential,
                                              expires_on: creds.expires_on });
  return writeConfigData(file, data);
}

// Atomic, owner-only write of a config object (also used to restore the previous one in memory).
function writeConfigData(file, data) {
  ensurePrivateDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.config.json.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

module.exports = { readConfig, writeConfig, writeConfigData, ensurePrivateDir };
