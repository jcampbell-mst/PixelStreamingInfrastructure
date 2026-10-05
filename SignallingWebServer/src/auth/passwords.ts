// Copyright Epic Games, Inc. All Rights Reserved.
import crypto from 'crypto';

/**
 * scrypt parameters. N=2^15 costs a few hundred milliseconds of CPU on a modest
 * server, which is the point: it is paid once per sign-in, and it makes an offline
 * attack on a stolen store file expensive. r/p are the standard values for N=2^15.
 */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
// 128 * N * r bytes is 32 MiB here, which is exactly node's default cap, so the cap
// has to be raised explicitly or scrypt refuses to run.
const SCRYPT_MAX_MEM = 96 * 1024 * 1024;

const HASH_PREFIX = 'scrypt';

/** A fixed hash used to spend the same CPU on an unknown username as on a real one. */
let dummyHashPromise: Promise<string> | null = null;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.scrypt(
            password,
            salt,
            KEY_LENGTH,
            { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEM },
            (error, derivedKey) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(derivedKey);
                }
            }
        );
    });
}

/**
 * Hashes a password as `scrypt$N$r$p$salt$key`, with a fresh 16 byte salt.
 * Async so the derivation runs on libuv's thread pool and never blocks the
 * signalling event loop.
 */
export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt);
    return [
        HASH_PREFIX,
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        salt.toString('base64url'),
        key.toString('base64url')
    ].join('$');
}

/**
 * Verifies a password against a stored hash in constant time.
 *
 * Passing `null` (an account whose invite has not been redeemed yet) still costs a
 * full derivation, so an attacker cannot tell a real username from an unknown one by
 * timing the response.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
    if (!stored) {
        if (!dummyHashPromise) {
            dummyHashPromise = hashPassword('placeholder-account-without-a-password');
        }
        const dummy = await dummyHashPromise;
        await verifyPassword(password, dummy);
        return false;
    }

    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== HASH_PREFIX) {
        return false;
    }

    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
        return false;
    }

    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');

    const actual = await new Promise<Buffer>((resolve, reject) => {
        crypto.scrypt(
            password,
            salt,
            expected.length,
            { N: n, r, p, maxmem: SCRYPT_MAX_MEM },
            (error, derivedKey) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(derivedKey);
                }
            }
        );
    });

    if (actual.length !== expected.length) {
        return false;
    }
    return crypto.timingSafeEqual(actual, expected);
}

/** A URL-safe random token. 32 bytes is 256 bits of entropy. */
export function randomToken(bytes = 32): string {
    return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Hashes a token (session id, invite code) for storage. These are 256 bit random
 * values, so a plain SHA-256 is enough: there is no dictionary to attack.
 */
export function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of two hex strings of the same length. */
export function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) {
        return false;
    }
    return crypto.timingSafeEqual(left, right);
}

/**
 * Password policy: length is the only thing that measurably helps, so no character
 * class rules. 8 characters is the floor NIST SP 800-63B sets for memorised secrets.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/** Returns a human readable problem with the password, or null if it is acceptable. */
export function checkPasswordPolicy(password: string, username?: string): string | null {
    if (password.length < PASSWORD_MIN_LENGTH) {
        return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
        return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
    }
    const lowered = password.toLowerCase();
    if (username && username.length >= 3 && lowered.indexOf(username.toLowerCase()) >= 0) {
        return 'Password must not contain the username.';
    }
    if (/^(.)\1+$/.test(password)) {
        return 'Password must not be a single repeated character.';
    }
    return null;
}

/** Generates a readable, high entropy password for the CLI bootstrap path. */
export function generatePassword(): string {
    const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(20);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += alphabet[bytes[i] % alphabet.length];
    }
    return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15)}`;
}

/** Generates an invite code. 32 bytes, URL safe. */
export function generateInviteCode(): string {
    return randomToken(32);
}
