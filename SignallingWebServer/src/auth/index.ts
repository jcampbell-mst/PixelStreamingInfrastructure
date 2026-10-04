// Copyright Epic Games, Inc. All Rights Reserved.
import { RequestHandler, Router } from 'express';
import { AuthStore, defaultStorePath } from './store';
import { SessionManager } from './sessions';
import { createAuthRouter } from './routes';
import { IWebSocketClientInfo, createVerifyClient, requireAuth, resolveSession } from './gate';
import { IPageContext } from './pages';
import { IAuthLogger } from './util';

export { AuthStore, defaultStorePath } from './store';
export { IAuthLogger } from './util';

export interface IAuthOptions {
    /** Where the users/invites/sessions file lives. Defaults to `data/auth.json`. */
    storePath?: string;
    /** How long a signed-in session lasts, refreshed on use. */
    sessionDays?: number;
    /** Default lifetime of a newly issued invite. */
    inviteDays?: number;
    /** Absolute base URL used to build invite links, e.g. `https://example.com`. */
    baseUrl?: string;
    /** Name shown on the sign-in and admin pages. */
    appName?: string;
    /** Port the Unreal streamers connect to; only used to describe the network in the admin page. */
    streamerPort: number;
    logger: IAuthLogger;
}

export interface IAuth {
    store: AuthStore;
    sessions: SessionManager;
    /** Attaches the session to the request. Mount before `router`. */
    resolveSession: RequestHandler;
    /** The sign-in, invite, account and admin pages. */
    router: Router;
    /** Rejects unauthenticated requests. Mount after `router`. */
    gate: RequestHandler;
    /** `ws` server options for the player port. */
    playerWsOptions: {
        verifyClient: (
            info: IWebSocketClientInfo,
            callback: (allowed: boolean, code?: number, message?: string) => void
        ) => void;
    };
    /** Stops the sweeper, ends the auth router and writes the store out. */
    shutdown(): void;
}

/** Expired sessions and spent invites are pruned on this cadence. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Builds the whole auth surface from one place so `index.ts` and the CLI agree on where
 * the store lives and how sessions behave.
 */
export function createAuth(options: IAuthOptions): IAuth {
    const store = new AuthStore(options.storePath ?? defaultStorePath());
    store.load();

    const sessions = new SessionManager(store, { days: options.sessionDays ?? 30 });

    const pageContext: IPageContext = {
        appName: options.appName ?? 'Live streams',
        baseUrl: options.baseUrl ?? '',
        streamerPort: options.streamerPort
    };

    const router = createAuthRouter({
        store,
        sessions,
        pageContext,
        logger: options.logger,
        inviteDays: options.inviteDays ?? 7
    });

    const sweepTimer = setInterval(() => {
        store.sweep(new Date());
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    const shutdown = () => {
        clearInterval(sweepTimer);
        store.flush();
    };
    process.on('exit', shutdown);

    return {
        store,
        sessions,
        resolveSession: resolveSession(sessions),
        router,
        gate: requireAuth({ sessions, logger: options.logger }),
        playerWsOptions: { verifyClient: createVerifyClient(sessions, options.logger) },
        shutdown
    };
}
