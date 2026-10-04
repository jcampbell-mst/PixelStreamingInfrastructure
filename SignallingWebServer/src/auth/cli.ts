// Copyright Epic Games, Inc. All Rights Reserved.
//
// User management for the signalling server, run from the command line:
//
//   node dist/auth/cli.js create-admin alice
//   node dist/auth/cli.js invite bob --label "Bob, camera 2"
//   node dist/auth/cli.js list-users
//
// Every command takes `--store <file>`; it defaults to the same file the server uses
// (`SignallingWebServer/data/auth.json`), so the CLI and the server never disagree.
import crypto from 'crypto';
import { Command } from 'commander';
import { AuthStore, defaultStorePath, inviteStatus } from './store';
import { checkPasswordPolicy, generatePassword, hashPassword, PASSWORD_MIN_LENGTH } from './passwords';
import { MAX_INVITE_DAYS, USERNAME_PATTERN, inviteUrl, issueInvite } from './invites';
import { formatTimestamp } from './util';

const DEFAULT_BASE = '';
/** Width of the username column in `list-users`. */
const COLUMN = 22;

interface IGlobalOptions {
    store: string;
    base: string;
}

/** `padEnd` is ES2017 and this project targets ES2016. */
function pad(value: string, width: number): string {
    let padded = value;
    while (padded.length < width) {
        padded += ' ';
    }
    return padded;
}

function openStore(command: Command): AuthStore {
    const { store: file } = command.optsWithGlobals<IGlobalOptions>();
    const authStore = new AuthStore(file);
    authStore.load();
    return authStore;
}

function baseUrl(command: Command): string {
    return command.optsWithGlobals<IGlobalOptions>().base ?? DEFAULT_BASE;
}

function fail(message: string): never {
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
}

/** Prints the link plus a reminder that it is single use. */
function printLink(command: Command, username: string, code: string, expiresAt: string): void {
    process.stdout.write(
        `Invite link for ${username} (single use, expires ${formatTimestamp(expiresAt)}):\n`
    );
    process.stdout.write(`  ${inviteUrl(baseUrl(command), code)}\n`);
    if (baseUrl(command).length === 0) {
        process.stdout.write('Tip: pass --base https://your.domain to print an absolute link.\n');
    }
}

async function createAccount(command: Command, username: string, role: 'admin' | 'user'): Promise<void> {
    const store = openStore(command);
    const { password, force } = command.opts<{ password?: string; force?: boolean }>();
    const name = username.trim().toLowerCase();
    // The same rule the admin page applies, so a name created here can always be
    // re-invited or reset from the web UI later.
    if (!USERNAME_PATTERN.test(name)) {
        fail('Usernames are 3 to 32 characters: letters, digits, dot, dash or underscore.');
    }

    const existing = store.findUserByName(name);
    if (existing && existing.passwordHash && !force) {
        fail(`"${name}" already has a password. Use set-password or reset-link instead.`);
    }
    if (existing && existing.disabled) {
        fail(`"${name}" is disabled. Enable it first: enable-user ${name}`);
    }

    const plain = password ?? generatePassword();
    const problem = checkPasswordPolicy(plain, name);
    if (problem) {
        fail(problem);
    }
    const passwordHash = await hashPassword(plain);

    if (existing) {
        store.updateUser(existing.id, { passwordHash, role });
    } else {
        const now = new Date().toISOString();
        store.addUser({
            id: crypto.randomUUID(),
            username: name,
            displayName: name,
            role,
            passwordHash,
            disabled: false,
            createdAt: now,
            lastLoginAt: null,
            createdBy: null
        });
    }
    store.flush();
    process.stdout.write(
        `${role === 'admin' ? 'Admin' : 'User'} "${name}" ${existing ? 'updated' : 'created'}.\n`
    );
    if (!password) {
        process.stdout.write(`Password (shown once): ${plain}\n`);
    }
}

function setDisabled(command: Command, username: string, disabled: boolean): void {
    const store = openStore(command);
    const user = store.findUserByName(username);
    if (!user) {
        fail(`No account called "${username}".`);
    }
    if (disabled && user.role === 'admin' && store.countEnabledAdmins(user.id) === 0) {
        fail(`"${user.username}" is the last admin who can sign in, so it cannot be disabled.`);
    }
    store.updateUser(user.id, { disabled });
    let ended = 0;
    if (disabled) {
        ended = store.removeSessionsForUser(user.id);
        store.revokeInvitesForUser(user.id, new Date());
    }
    store.flush();
    process.stdout.write(
        disabled
            ? `Disabled "${user.username}" and ended ${ended} session(s).\n`
            : `Enabled "${user.username}".\n`
    );
}

/** Runs the CLI. The file is only ever executed as a program, never imported. */
async function main(): Promise<void> {
    const program = new Command();
    program
        .name('auth')
        .description('Manage users, invites and sessions for the signalling server.')
        .option('-s, --store <file>', 'path to the auth store file', defaultStorePath())
        .option('-b, --base <url>', 'base URL used for invite links', DEFAULT_BASE)
        .showHelpAfterError();

    program
        .command('create-admin')
        .description('create an admin account (prints a generated password unless --password is given)')
        .argument('<username>')
        .option('-p, --password <password>', `password (minimum ${PASSWORD_MIN_LENGTH} characters)`)
        .option('-f, --force', 'overwrite the password of an existing account')
        .action(async (username: string, _options: unknown, command: Command) => {
            await createAccount(command, username, 'admin');
        });

    program
        .command('create-user')
        .description('create an ordinary account')
        .argument('<username>')
        .option('-p, --password <password>', `password (minimum ${PASSWORD_MIN_LENGTH} characters)`)
        .option('-f, --force', 'overwrite the password of an existing account')
        .action(async (username: string, _options: unknown, command: Command) => {
            await createAccount(command, username, 'user');
        });

    program
        .command('invite')
        .description('create an account and print a single-use link that sets its password')
        .argument('<username>')
        .option('-l, --label <label>', 'note shown next to the invite', '')
        .option('-r, --role <role>', 'admin or user', 'user')
        .option('-d, --days <days>', 'how long the link stays valid', '7')
        .action((username: string, _options: unknown, command: Command) => {
            const store = openStore(command);
            const opts = command.opts<{ label: string; role: string; days: string }>();
            const days = Number.parseInt(opts.days, 10);
            if (!Number.isFinite(days) || days < 1 || days > MAX_INVITE_DAYS) {
                fail(`--days must be between 1 and ${MAX_INVITE_DAYS}.`);
            }
            const outcome = issueInvite(store, {
                username,
                label: opts.label,
                role: opts.role === 'admin' ? 'admin' : 'user',
                days,
                createdBy: 'cli'
            });
            if (!outcome.ok) {
                fail(inviteError(outcome.error));
            }
            store.flush();
            printLink(command, outcome.user.username, outcome.code, outcome.invite.expiresAt);
        });

    program
        .command('reset-link')
        .description('print a single-use link that sets a new password for an existing account')
        .argument('<username>')
        .option('-d, --days <days>', 'how long the link stays valid', '1')
        .action((username: string, _options: unknown, command: Command) => {
            const store = openStore(command);
            const opts = command.opts<{ days: string }>();
            const days = Number.parseInt(opts.days, 10);
            if (!Number.isFinite(days) || days < 1 || days > MAX_INVITE_DAYS) {
                fail(`--days must be between 1 and ${MAX_INVITE_DAYS}.`);
            }
            const outcome = issueInvite(store, {
                username,
                label: '',
                role: 'user',
                days,
                createdBy: 'cli',
                mode: 'reset'
            });
            if (!outcome.ok) {
                fail(inviteError(outcome.error));
            }
            store.flush();
            printLink(command, outcome.user.username, outcome.code, outcome.invite.expiresAt);
        });

    program
        .command('set-password')
        .description('set a password directly, without a link')
        .argument('<username>')
        .option('-p, --password <password>', 'password; generated and printed when omitted')
        .action(async (username: string, _options: unknown, command: Command) => {
            const store = openStore(command);
            const { password } = command.opts<{ password?: string }>();
            const user = store.findUserByName(username);
            if (!user) {
                fail(`No account called "${username}".`);
            }
            const plain = password ?? generatePassword();
            const problem = checkPasswordPolicy(plain, user.username);
            if (problem) {
                fail(problem);
            }
            store.updateUser(user.id, { passwordHash: await hashPassword(plain) });
            store.removeSessionsForUser(user.id);
            store.flush();
            process.stdout.write(`Password set for "${user.username}". Existing sessions were ended.\n`);
            if (!password) {
                process.stdout.write(`Password (shown once): ${plain}\n`);
            }
        });

    program
        .command('revoke-sessions')
        .description('sign an account out everywhere')
        .argument('<username>')
        .action((username: string, _options: unknown, command: Command) => {
            const store = openStore(command);
            const user = store.findUserByName(username);
            if (!user) {
                fail(`No account called "${username}".`);
            }
            const ended = store.removeSessionsForUser(user.id);
            store.flush();
            process.stdout.write(`Ended ${ended} session(s) for "${user.username}".\n`);
        });

    program
        .command('disable-user')
        .description("block sign-in and end the account's sessions")
        .argument('<username>')
        .action((username: string, _options: unknown, command: Command) => {
            setDisabled(command, username, true);
        });

    program
        .command('enable-user')
        .description('allow sign-in again for a disabled account')
        .argument('<username>')
        .action((username: string, _options: unknown, command: Command) => {
            setDisabled(command, username, false);
        });

    program
        .command('delete-user')
        .description('remove an account, its sessions and its invites')
        .argument('<username>')
        .option('-f, --force', 'delete even if it is the last sign-in-capable admin')
        .action((username: string, _options: unknown, command: Command) => {
            const store = openStore(command);
            const { force } = command.opts<{ force?: boolean }>();
            const user = store.findUserByName(username);
            if (!user) {
                fail(`No account called "${username}".`);
            }
            if (!force && user.role === 'admin' && store.countEnabledAdmins(user.id) === 0) {
                fail(
                    `"${user.username}" is the last admin who can sign in. Create another admin first, or pass --force.`
                );
            }
            store.removeSessionsForUser(user.id);
            store.revokeInvitesForUser(user.id, new Date());
            store.removeUser(user.id);
            store.flush();
            process.stdout.write(`Deleted "${user.username}".\n`);
        });

    program
        .command('list-users')
        .description('list accounts, roles and pending invites')
        .action((_options: unknown, command: Command) => {
            const store = openStore(command);
            const now = new Date();
            const users = store.listUsers();
            if (users.length === 0) {
                process.stdout.write('No accounts yet. Create one with: create-admin <username>\n');
                return;
            }
            const rows = users.slice().sort((a, b) => a.username.localeCompare(b.username));
            for (const user of rows) {
                const invite = store.findPendingInviteForUser(user.id);
                const status = user.disabled
                    ? 'disabled'
                    : user.passwordHash
                      ? `active, ${store.sessionsForUser(user.id).length} session(s)`
                      : `invite ${invite ? inviteStatus(invite, now) : 'missing'}`;
                const last = user.lastLoginAt ? formatTimestamp(user.lastLoginAt) : 'never';
                process.stdout.write(
                    `${pad(user.username, COLUMN)}${pad(user.role, 8)}${pad(status, COLUMN)}last sign-in: ${last}\n`
                );
            }
        });

    await program.parseAsync(process.argv);
}

function inviteError(error: string): string {
    switch (error) {
        case 'username-invalid':
            return 'Usernames are 3 to 32 characters: letters, digits, dot, dash or underscore.';
        case 'username-taken':
            return 'That username already has a password. Use set-password or reset-link instead.';
        case 'user-disabled':
            return 'That account is disabled. Enable it before issuing a reset link.';
        default:
            return 'The invite could not be created.';
    }
}

void main();
