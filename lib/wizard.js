"use strict";
// The sign-in wizard: runs in the new terminal tab (or inline as a fallback).
//
//  1. server URL      validated (https, or http on loopback), then health.ping must identify Brewboard
//  2. capability      per-client credentials? if not, the shared-secret warning needs an explicit choice
//  3. login ID        non-empty; not assumed to be an email
//  4. password        hidden; kept only in memory until the login request, never logged or saved
//  5. login           auth.login_and_get_keys, then auth.get_current_user with the new credential
//  6. save            ~/.bb/config.json (0600, atomic) only after the credential is verified
//  7. confirm         the installed bb.py itself must accept the saved configuration (auth-check)
const os = require("os");
const prompt = require("./prompt");
const api = require("./brewboard-api");
const { normalizeServerUrl, UrlError } = require("./url");
const fs = require("fs");
const tracking = require("./tracking");
const { readConfig, writeConfig, writeConfigData } = require("./config");
const { authCheck } = require("./check");
const { writeStatus } = require("./status");
const { acquire } = require("./lock");
const messages = require("./messages");

const MAX_PASSWORD_ATTEMPTS = 3;

async function runWizard({ paths, statusFile = null, io = {}, python = "python3", env = process.env,
                           apiOpts = {}, pauseAtEnd = false } = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const say = (s = "") => output.write(s + "\n");
  const ask = { input, output };

  const lock = acquire(paths.lockFile);
  if (!lock.acquired) {
    const msg = `Another Brewboard sign-in is already running (pid ${lock.holder && lock.holder.pid}). Finish or close it first.`;
    say(msg);
    writeStatus(statusFile, "busy", { message: msg });
    return { state: "busy" };
  }
  writeStatus(statusFile, "started");
  try {
    const result = await steps({ paths, ask, say, python, env, apiOpts, output });
    writeStatus(statusFile, result.state, { message: result.message, user: result.user });
    if (pauseAtEnd) await waitForEnter(ask, say);
    return result;
  } catch (e) {
    const cancelled = e instanceof prompt.Cancelled;
    const message = cancelled ? "Sign-in cancelled. Nothing was changed." : `Sign-in failed: ${e.message}`;
    say(`\n${message}`);
    if (!cancelled) say(messages.recovery());
    writeStatus(statusFile, cancelled ? "cancelled" : "failed", { message });
    if (pauseAtEnd) await waitForEnter(ask, say).catch(() => {});
    return { state: cancelled ? "cancelled" : "failed", message };
  } finally {
    lock.release();
  }
}

async function steps({ paths, ask, say, python, env, apiOpts }) {
  const previous = readConfig(paths.configFile);
  say(messages.wizardHeader());

  // 1. server
  let url;
  for (;;) {
    const raw = await prompt.text({ ...ask, message: "Enter your ERPNext/Brewboard server URL:",
                                    defaultValue: previous.url || "" });
    try {
      url = normalizeServerUrl(raw);
      say(`Checking ${url} …`);
      await api.ping(url, apiOpts);
      break;
    } catch (e) {
      if (!(e instanceof UrlError || e instanceof api.ApiError)) throw e;
      say(`  ${e.message}`);
      say("  Enter another URL, or press Ctrl+C to cancel.");
    }
  }
  say("  Brewboard backend found.");

  // 2. capability: decided before any password is typed
  const perClient = await api.supportsClientCredentials(url, apiOpts);
  if (!perClient) {
    say(messages.sharedSecretWarning());
    const go = await prompt.select({ ...ask, message: "Continue?", choices: [
      { label: "Continue and replace the shared secret", value: true },
      { label: "Cancel", value: false, cancel: true },
    ] });
    if (!go) throw new prompt.Cancelled();
  }

  // 3 + 4 + 5. login ID, password, login
  const usr = await askNonEmpty(ask, say, "Enter your ERPNext login ID or email:", previous.user || "");
  let creds;
  for (let attempt = 1; ; attempt++) {
    let pwd = await prompt.password({ ...ask, message: "Enter your ERPNext/Brewboard password:" });
    if (!pwd) { say("  The password cannot be empty."); attempt--; continue; }
    try {
      say("Signing in …");
      creds = await api.login(url, usr, pwd, perClient
        ? { ...apiOpts, client: "cli", label: `Brewboard skill (npx) on ${os.hostname()}`.slice(0, 140) }
        : apiOpts);
      break;
    } catch (e) {
      if (e instanceof api.ApiError && e.code === "bad_credentials" && attempt < MAX_PASSWORD_ATTEMPTS) {
        say(`  ${e.message} (attempt ${attempt} of ${MAX_PASSWORD_ATTEMPTS})`);
        continue;
      }
      throw e;
    } finally {
      pwd = null; // drop the only reference
    }
  }
  if (perClient && !creds.auth_source) {
    say("  Note: the server did not return a per-client credential; it issued the account's shared key pair.");
  }

  // Verify the new credential before anything is saved.
  const me = await api.whoami(url, creds, apiOpts);
  say(`  Signed in as ${me.full_name || me.name} (${me.name}).`);

  // 6. save (only now). 7. the real client must accept the saved file; otherwise the previous
  //    configuration is put back (from memory, no backup file) and nothing is revoked.
  const hadConfig = Object.keys(previous).length > 0;
  const beforeRaw = fs.existsSync(paths.configFile) ? fs.readFileSync(paths.configFile) : null;
  writeConfig(paths.configFile, { url, creds, user: me.name });
  const check = await authCheck({ paths, python, env });
  if (check.status !== "ok") {
    if (hadConfig) writeConfigData(paths.configFile, previous);
    else fs.rmSync(paths.configFile, { force: true });
    throw new Error(`bb.py did not accept the new configuration (${check.status}: ${check.message || ""}); ` +
                    `the previous configuration was ${hadConfig ? "restored" : "removed again"}.`);
  }
  // Record that the installer wrote config.json (and keep the user's earlier one), for uninstall.
  tracking.recordConfig(paths, beforeRaw);
  beforeRaw && beforeRaw.fill(0);
  // Retire this CLI's previous credential, never another client's.
  if (previous.auth_source && previous.credential && previous.url === url && previous.user === me.name &&
      previous.credential !== creds.credential) {
    const revoked = await api.revokeCredential(url, creds, previous.credential, apiOpts).catch(() => false);
    say(revoked ? `  Revoked this CLI's previous credential ${previous.credential}.`
                : `  Could not revoke the previous credential ${previous.credential}; see \`bb.py credentials\`.`);
  }
  say(messages.success({ user: me.name, perClient: Boolean(creds.auth_source), expiresOn: creds.expires_on,
                         paths }));
  return { state: "success", user: me.name, message: "Brewboard authentication configured successfully." };
}

async function askNonEmpty(ask, say, message, defaultValue) {
  for (;;) {
    const v = (await prompt.text({ ...ask, message, defaultValue })).trim();
    if (v) return v;
    say("  This cannot be empty.");
  }
}

async function waitForEnter(ask, say) {
  say("\nPress Enter to close this tab.");
  await prompt.text({ ...ask, message: "" }).catch(() => {});
}

module.exports = { runWizard };
