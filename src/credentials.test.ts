import assert from "node:assert/strict"
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { lockSync } from "proper-lockfile"
import {
    loadPersistedAccountSource,
    parseOAuthResponse,
    saveAccountSource,
    syncAuthJson,
} from "./credentials.ts"

let dir = ""
let prevEnv: string | undefined

beforeEach(() => {
    prevEnv = process.env.PI_CODING_AGENT_DIR
    dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-test-"))
    process.env.PI_CODING_AGENT_DIR = dir
})

afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevEnv
    rmSync(dir, { recursive: true, force: true })
})

test("parseOAuthResponse: maps a valid token response", () => {
    const creds = parseOAuthResponse(
        JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 100,
        }),
        "old-refresh",
        1_000,
    )
    assert.ok(creds)
    assert.equal(creds.accessToken, "new-access")
    assert.equal(creds.refreshToken, "new-refresh")
    assert.equal(creds.expiresAt, 1_000 + 100 * 1000)
})

test("parseOAuthResponse: keeps current refresh token when not rotated", () => {
    const creds = parseOAuthResponse(
        JSON.stringify({ access_token: "a", expires_in: 10 }),
        "keep-me",
        0,
    )
    assert.ok(creds)
    assert.equal(creds.refreshToken, "keep-me")
})

test("parseOAuthResponse: defaults expires_in to 36000s", () => {
    const creds = parseOAuthResponse(
        JSON.stringify({ access_token: "a" }),
        "r",
        0,
    )
    assert.ok(creds)
    assert.equal(creds.expiresAt, 36_000 * 1000)
})

test("parseOAuthResponse: returns null without an access token", () => {
    assert.equal(parseOAuthResponse(JSON.stringify({ error: "x" }), "r"), null)
    assert.equal(parseOAuthResponse("not json", "r"), null)
})

test("syncAuthJson: writes a pi oauth entry under anthropic", () => {
    syncAuthJson({
        accessToken: "acc",
        refreshToken: "ref",
        expiresAt: 12345,
    })
    const raw = readFileSync(join(dir, "auth.json"), "utf-8")
    const parsed = JSON.parse(raw) as {
        anthropic: {
            type: string
            access: string
            refresh: string
            expires: number
        }
    }
    assert.deepEqual(parsed.anthropic, {
        type: "oauth",
        access: "acc",
        refresh: "ref",
        expires: 12345,
    })
})

test("syncAuthJson: preserves other providers in auth.json", () => {
    const authPath = join(dir, "auth.json")
    // Seed an unrelated provider, then sync anthropic on top of it.
    writeFileSync(
        authPath,
        JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
        "utf-8",
    )
    syncAuthJson({ accessToken: "a2", refreshToken: "r2", expiresAt: 2 })
    const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as {
        anthropic: { access: string }
        openai: { type: string; key: string }
    }
    assert.equal(parsed.anthropic.access, "a2")
    assert.deepEqual(parsed.openai, { type: "api_key", key: "sk-test" })
})

test("syncAuthJson: never wipes a malformed auth.json, keeps a backup instead", () => {
    const authPath = join(dir, "auth.json")
    // Truncated JSON with another provider's credential inside.
    const corrupt = '{"openai": {"type": "api_key", "key": "sk-test"'
    writeFileSync(authPath, corrupt, "utf-8")
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    // The corrupt file must be left exactly as it was, not reset to {} +
    // anthropic (which wiped every other provider's credentials).
    assert.equal(readFileSync(authPath, "utf-8"), corrupt)
    const backups = readdirSync(dir).filter((f) =>
        f.startsWith("auth.json.corrupt-"),
    )
    assert.equal(backups.length, 1)
    assert.equal(readFileSync(join(dir, backups[0]), "utf-8"), corrupt)
})

test("syncAuthJson: does not write while another process holds the auth.json lock", () => {
    const authPath = join(dir, "auth.json")
    writeFileSync(
        authPath,
        JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
        "utf-8",
    )
    // Hold the lock the same way pi does while writing credentials.
    const release = lockSync(authPath, { realpath: false })
    let threwLocked = false
    try {
        syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    } catch (err) {
        threwLocked = (err as NodeJS.ErrnoException)?.code === "ELOCKED"
    }
    release()
    // Losing the lock contention race must throw, not silently overwrite.
    assert.equal(threwLocked, true)
    const held = JSON.parse(readFileSync(authPath, "utf-8")) as {
        openai: { key: string }
    }
    assert.equal(held.openai.key, "sk-test")
    // Once the lock is free, the sync works and preserves the other provider.
    syncAuthJson({ accessToken: "a2", refreshToken: "r2", expiresAt: 2 })
    const after = JSON.parse(readFileSync(authPath, "utf-8")) as {
        anthropic: { access: string }
        openai: { key: string }
    }
    assert.equal(after.anthropic.access, "a2")
    assert.equal(after.openai.key, "sk-test")
})

test("syncAuthJson: syncs a BOM-prefixed auth.json instead of treating it as corrupt", () => {
    const authPath = join(dir, "auth.json")
    writeFileSync(
        authPath,
        `\uFEFF${JSON.stringify({ openai: { type: "api_key", key: "sk-test" } })}`,
        "utf-8",
    )
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    const after = JSON.parse(readFileSync(authPath, "utf-8")) as {
        anthropic: { access: string }
        openai: { key: string }
    }
    assert.equal(after.anthropic.access, "a")
    assert.equal(after.openai.key, "sk-test")
    // No corrupt backup should be created for a merely BOM-prefixed file.
    assert.equal(
        readdirSync(dir).filter((f) => f.startsWith("auth.json.corrupt-"))
            .length,
        0,
    )
})

test("syncAuthJson: does not pile up identical corrupt backups", () => {
    const authPath = join(dir, "auth.json")
    const corrupt = '{"openai": {"type": "api_key", "key": "sk-test"'
    writeFileSync(authPath, corrupt, "utf-8")
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    assert.equal(
        readdirSync(dir).filter((f) => f.startsWith("auth.json.corrupt-"))
            .length,
        1,
    )
})

test("account source persistence round-trips", () => {
    assert.equal(loadPersistedAccountSource(), null)
    saveAccountSource("Claude Code-credentials")
    assert.equal(loadPersistedAccountSource(), "Claude Code-credentials")
})
