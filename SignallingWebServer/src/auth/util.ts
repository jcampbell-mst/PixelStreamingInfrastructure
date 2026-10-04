// Copyright Epic Games, Inc. All Rights Reserved.
import { Request } from 'express';

/**
 * Minimal logging surface. Kept here rather than reusing the signalling server's
 * logger so the auth code has no dependency on the Signalling package.
 */
export interface IAuthLogger {
    info(message: string): void;
    warn(message: string): void;
}

/** True when the request reached us over TLS, including via a terminating proxy. */
export function isSecureRequest(req: Request): boolean {
    if (req.secure) {
        return true;
    }
    const forwarded = req.headers['x-forwarded-proto'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return typeof value === 'string' && value.split(',')[0].trim().toLowerCase() === 'https';
}

/**
 * Best available client address. Behind Caddy this is only the real address when the
 * server was started with `--reverse-proxy`, otherwise every client shares one.
 */
export function clientIp(req: Request): string {
    return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Only allow redirects to a path on this site. Anything protocol relative or absolute
 * is dropped, so `next` cannot be used to bounce a freshly signed-in user to another
 * host.
 */
export function safeRedirectPath(raw: unknown, fallback: string): string {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) {
        return fallback;
    }
    if (raw[0] !== '/' || raw[1] === '/') {
        return fallback;
    }
    // Backslashes are normalised to slashes by some browsers, which would let
    // `/\evil.com` escape.
    if (raw.indexOf('\\') >= 0 || raw.indexOf('\r') >= 0 || raw.indexOf('\n') >= 0) {
        return fallback;
    }
    return raw;
}

/** Escapes text for interpolation into HTML. */
export function escapeHtml(value: string): string {
    let out = '';
    for (let i = 0; i < value.length; i++) {
        const character = value[i];
        if (character === '&') {
            out += '&amp;';
        } else if (character === '<') {
            out += '&lt;';
        } else if (character === '>') {
            out += '&gt;';
        } else if (character === '"') {
            out += '&quot;';
        } else if (character === "'") {
            out += '&#39;';
        } else {
            out += character;
        }
    }
    return out;
}

/** Short human readable rendering of an ISO timestamp, e.g. "12 Mar 14:05". */
export function formatTimestamp(iso: string | null): string {
    if (!iso) {
        return '-';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '-';
    }
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (value: number): string => (value < 10 ? `0${value}` : `${value}`);
    return `${pad(date.getDate())} ${months[date.getMonth()]} ${pad(date.getHours())}:${pad(
        date.getMinutes()
    )}`;
}

/** Relative description of a moment in the future or past, e.g. "in 6 days". */
export function formatRelative(iso: string, now: Date): string {
    const deltaMs = new Date(iso).getTime() - now.getTime();
    const past = deltaMs < 0;
    const seconds = Math.floor(Math.abs(deltaMs) / 1000);
    let amount: string;
    if (seconds < 60) {
        amount = `${seconds} second${seconds === 1 ? '' : 's'}`;
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        amount = `${minutes} minute${minutes === 1 ? '' : 's'}`;
    } else if (seconds < 86400) {
        const hours = Math.floor(seconds / 3600);
        amount = `${hours} hour${hours === 1 ? '' : 's'}`;
    } else {
        const days = Math.floor(seconds / 86400);
        amount = `${days} day${days === 1 ? '' : 's'}`;
    }
    return past ? `${amount} ago` : `in ${amount}`;
}
