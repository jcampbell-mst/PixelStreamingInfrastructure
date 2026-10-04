// Copyright Epic Games, Inc. All Rights Reserved.
import { ISessionRecord, IUserRecord } from './store';

declare global {
    namespace Express {
        interface Request {
            /** The signed-in account, set by the auth session middleware. */
            user?: IUserRecord;
            /** The raw session cookie value for this request. */
            sessionToken?: string;
            /** The session record backing `user`. */
            authSession?: ISessionRecord;
        }
    }
}
