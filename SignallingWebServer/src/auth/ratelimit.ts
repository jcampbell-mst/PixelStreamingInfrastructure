// Copyright Epic Games, Inc. All Rights Reserved.

interface IBucket {
    count: number;
    resetAt: number;
}

/**
 * Fixed window rate limiter, small enough to live in memory.
 *
 * Used to slow down password guessing and invite code guessing. It is a mitigation,
 * not the primary defence: slow password hashing and long random invite codes are.
 * Keys are IP addresses, optionally combined with a username, and the caller decides
 * which failures count.
 */
export class RateLimiter {
    private readonly windowMs: number;
    private readonly max: number;
    private readonly buckets = new Map<string, IBucket>();
    private operations = 0;

    public constructor(windowMs: number, max: number) {
        this.windowMs = windowMs;
        this.max = max;
    }

    /**
     * Records one attempt against a key.
     *
     * Returns null when the attempt may proceed, or the number of seconds to wait
     * when the key has exhausted its budget.
     */
    public hit(key: string, now = Date.now()): number | null {
        this.operations++;
        if (this.operations % 512 === 0) {
            this.prune(now);
        }

        const bucket = this.buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
            return null;
        }

        bucket.count++;
        if (bucket.count > this.max) {
            return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        }
        // Opportunistically drop entries that have gone stale, so a long lived server
        // does not accumulate one map entry per address that ever tried to sign in.
        if (this.buckets.size > 10000) {
            this.prune(now);
        }
        return null;
    }

    /** Forgets the attempts for a key, called after a success. */
    public reset(key: string): void {
        this.buckets.delete(key);
    }

    /** Number of keys currently tracked. Exposed for diagnostics. */
    public get size(): number {
        return this.buckets.size;
    }

    private prune(now: number): void {
        const stale: string[] = [];
        this.buckets.forEach((bucket, key) => {
            if (bucket.resetAt <= now) {
                stale.push(key);
            }
        });
        for (const key of stale) {
            this.buckets.delete(key);
        }
    }
}

export interface IAuthLimiters {
    /** Failed sign-ins from one address, across all usernames. */
    loginIp: RateLimiter;
    /** Failed sign-ins for one address and username pair. */
    loginAccount: RateLimiter;
    /** Invite code redemptions attempted from one address. */
    invite: RateLimiter;
    /** Admin mutations from one address. */
    admin: RateLimiter;
}

/** Builds the limiter set with the budgets used by the auth routes. */
export function createLimiters(): IAuthLimiters {
    const fifteenMinutes = 15 * 60 * 1000;
    const oneHour = 60 * 60 * 1000;
    return {
        // A shared proxy collapses every client into one address, so this budget is
        // deliberately loose: it exists to stop a flood, not to police typing.
        loginIp: new RateLimiter(fifteenMinutes, 30),
        loginAccount: new RateLimiter(fifteenMinutes, 6),
        invite: new RateLimiter(oneHour, 20),
        admin: new RateLimiter(oneHour, 200)
    };
}
