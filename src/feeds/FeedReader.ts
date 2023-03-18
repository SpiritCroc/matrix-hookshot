import { MatrixClient } from "matrix-bot-sdk";
import { BridgeConfigFeeds } from "../Config/Config";
import { ConnectionManager } from "../ConnectionManager";
import { FeedConnection } from "../Connections";
import { Logger } from "matrix-appservice-bridge";
import { MessageQueue } from "../MessageQueue";

import Ajv from "ajv";
import axios from "axios";
import iconv from "iconv-lite";
import Parser from "rss-parser";
import Metrics from "../Metrics";
import UserAgent from "../UserAgent";
import { randomUUID } from "crypto";
import { StatusCodes } from "http-status-codes";

const log = new Logger("FeedReader");

// Fix ISO-8859-1 encoding in feeds resulting in \uFFFD
// https://github.com/axios/axios/issues/332#issuecomment-222744486
axios.interceptors.response.use(response => {
    let ctype = response.headers["content-type"];
    if (ctype.includes("charset=ISO-8859-1")) {
        response.data = iconv.decode(response.data, 'ISO-8859-1');
    }
    return response;
})

export class FeedError extends Error {
    constructor(
        public url: string,
        public cause: Error,
        public readonly fetchKey: string,
    ) {
        super(`Error fetching feed ${url}: ${cause.message}`);
    }

    get shouldErrorBeSilent() {
        if (axios.isAxiosError(this.cause) && this.cause.response?.status) {
            if (this.cause.response.status % 500 < 100) {
                // 5XX error, retry these as it might be a server screwup.
                return true;
            } else if (this.cause.response.status % 400 < 100) {
                // 4XX error, actually report these because the server is explicity stating we can't read the resource.
                return false;
            }
        }
        if (axios.isAxiosError(this.cause) && this.cause.code && ['ECONNABORTED', 'ECONNRESET'].includes(this.cause.code)) {
            // Fuzzy match this, because it's usually a tempoary error.
            return true;
        }
        // Err on the side of safety and report the rest
        return false;
    }
}

export interface FeedEntry {
    feed: {
        title: string|null,
        url:   string,
    },
    title: string|null,
    link:  string|null,
    content: string|null,
    /**
     * Unique key to identify the specific fetch across entries.
     */
    fetchKey: string,
}

export interface FeedSuccess {
    url: string,
}

interface AccountData {
    [url: string]: string[],
}

const accountDataSchema = {
    type: 'object',
    patternProperties: {
        "https?://.+": {
            type: 'array',
            items: { type: 'string' },
        }
    },
    additionalProperties: false,
};
const ajv = new Ajv();
const validateAccountData = ajv.compile<AccountData>(accountDataSchema);

function stripHtml(input: string): string {
    return input.replace(/<[^>]*?>/g, '');
}

function normalizeUrl(input: string): string {
    const url = new URL(input);
    url.hash = '';
    return url.toString();
}

export class FeedReader {
    private connections: FeedConnection[];
    // ts should notice that we do in fact initialize it in constructor, but it doesn't (in this version)
    private observedFeedUrls: Set<string> = new Set();
    private seenEntries: Map<string, string[]> = new Map();
    // A set of last modified times for each url.
    private cacheTimes: Map<string, { etag?: string, lastModified?: string}> = new Map();
    static readonly seenEntriesEventType = "uk.half-shot.matrix-hookshot.feed.reader.seenEntries";

    constructor(
        private readonly config: BridgeConfigFeeds,
        private readonly connectionManager: ConnectionManager,
        private readonly queue: MessageQueue,
        private readonly matrixClient: MatrixClient,
    ) {
        this.connections = this.connectionManager.getAllConnectionsOfType(FeedConnection);
        this.calculateFeedUrls();
        connectionManager.on('new-connection', c => {
            if (c instanceof FeedConnection) {
                log.debug('New connection tracked:', c.connectionId);
                this.connections.push(c);
                this.calculateFeedUrls();
            }
        });
        connectionManager.on('connection-removed', removed => {
            if (removed instanceof FeedConnection) {
                this.connections = this.connections.filter(c => c.connectionId !== removed.connectionId);
                this.calculateFeedUrls();
            }
        });

        log.debug('Loaded feed URLs:', this.observedFeedUrls);

        void this.loadSeenEntries().then(() => {
            return this.pollFeeds();
        });
    }

    private calculateFeedUrls(): void {
        // just in case we got an invalid URL somehow
        const normalizedUrls = [];
        for (const conn of this.connections) {
            try {
                normalizedUrls.push(normalizeUrl(conn.feedUrl));
            } catch (err: unknown) {
                log.error(`Invalid feedUrl for connection ${conn.connectionId}: ${conn.feedUrl}. It will not be tracked`);
            }
        }
        this.observedFeedUrls = new Set(normalizedUrls);
        Metrics.feedsCount.set(this.observedFeedUrls.size);
    }

    private async loadSeenEntries(): Promise<void> {
        try {
            const accountData = await this.matrixClient.getAccountData<any>(FeedReader.seenEntriesEventType).catch((err: any) => {
                if (err.statusCode === 404) {
                    return {};
                } else {
                    throw err;
                }
            });
            if (!validateAccountData(accountData)) {
                const errors = validateAccountData.errors!.map(e => `${e.instancePath} ${e.message}`);
                throw new Error(`Invalid account data: ${errors.join(', ')}`);
            }
            for (const url in accountData) {
                this.seenEntries.set(url, accountData[url]);
            }
        } catch (err: unknown) {
            log.error(`Failed to load seen feed entries from accountData: ${err}. This may result in skipped entries`);
            // no need to wipe it manually, next saveSeenEntries() will make it right
        }
    }

    private async saveSeenEntries(): Promise<void> {
        const accountData: AccountData = {};
        for (const [url, guids] of this.seenEntries.entries()) {
            accountData[url.toString()] = guids;
        }
        await this.matrixClient.setAccountData(FeedReader.seenEntriesEventType, accountData);
    }

    private async pollFeeds(): Promise<void> {
        log.debug(`Checking for updates in ${this.observedFeedUrls.size} RSS/Atom feeds`);

        let seenEntriesChanged = false;

        const fetchingStarted = Date.now();

        for (const url of this.observedFeedUrls.values()) {
            const fetchKey = randomUUID();
            const { etag, lastModified } = this.cacheTimes.get(url) || {};
            try {
                const res = await axios.get(url, {
                    headers: {
                        'User-Agent': UserAgent,
                        ...(lastModified && { 'If-Modified-Since': lastModified}),
                        ...(etag && { 'If-None-Match': etag}),
                    },
                    // We don't want to wait forever for the feed.
                    timeout: this.config.pollTimeoutSeconds * 1000,
                });
                
                // Store any entity tags/cache times.
                if (res.headers.ETag) {
                    this.cacheTimes.set(url, { etag: res.headers.ETag});
                } else if (res.headers['Last-Modified']) {
                    this.cacheTimes.set(url, { lastModified: res.headers['Last-Modified'] });
                }

                const feed = await (new Parser()).parseString(res.data);
                let initialSync = false;
                let seenGuids = this.seenEntries.get(url);
                if (!seenGuids) {
                    initialSync = true;
                    seenGuids = [];
                    seenEntriesChanged = true; // to ensure we only treat it as an initialSync once
                }
                const seenGuidsSet = new Set(seenGuids);
                const newGuids = [];
                log.debug(`Found ${feed.items.length} entries in ${url}`);
                for (const item of feed.items) {
                    const guid = item.guid || item.id || item.link || item.title;
                    if (!guid) {
                        log.error(`Could not determine guid for entry in ${url}, skipping`);
                        continue;
                    }
                    newGuids.push(guid);

                    if (initialSync) {
                        log.debug(`Skipping entry ${guid} since we're performing an initial sync`);
                        continue;
                    }
                    if (seenGuidsSet.has(guid)) {
                        log.debug('Skipping already seen entry', guid);
                        continue;
                    }

                    const entry = {
                        feed: {
                            title: feed.title ? stripHtml(feed.title) : null,
                            url: url,
                        },
                        title: item.title ? stripHtml(item.title) : null,
                        content: item.content ? item.content : null,
                        link: item.link || null,
                        fetchKey
                    };

                    log.debug('New entry:', entry);
                    seenEntriesChanged = true;

                    this.queue.push<FeedEntry>({ eventName: 'feed.entry', sender: 'FeedReader', data: entry });
                }

                if (seenEntriesChanged) {
                    // Some RSS feeds can return a very small number of items then bounce
                    // back to their "normal" size, so we cannot just clobber the recent GUID list per request or else we'll
                    // forget what we sent and resend it. Instead, we'll keep 2x the max number of items that we've ever
                    // seen from this feed, up to a max of 10,000. 
                    // Adopted from https://github.com/matrix-org/go-neb/blob/babb74fa729882d7265ff507b09080e732d060ae/services/rssbot/rssbot.go#L304
                    const maxGuids = Math.min(Math.max(2 * newGuids.length, seenGuids.length), 10_000);
                    const newSeenItems = Array.from(new Set([ ...newGuids, ...seenGuids ]).values()).slice(0, maxGuids);
                    this.seenEntries.set(url, newSeenItems);
                }
                this.queue.push<FeedSuccess>({ eventName: 'feed.success', sender: 'FeedReader', data: { url: url } });
            } catch (err: unknown) {
                if (axios.isAxiosError(err)) {
                    // No new feed items, skip.
                    if (err.response?.status === StatusCodes.NOT_MODIFIED) {
                        continue;
                    }
                }
                const error = err instanceof Error ? err : new Error(`Unknown error ${err}`);
                const feedError = new FeedError(url.toString(), error, fetchKey);
                log.error("Unable to read feed:", feedError.message);
                this.queue.push<FeedError>({ eventName: 'feed.error', sender: 'FeedReader', data: feedError});
            }
        }
        if (seenEntriesChanged) await this.saveSeenEntries();

        const elapsed = Date.now() - fetchingStarted;
        Metrics.feedFetchMs.set(elapsed);

        let sleepFor: number;
        if (elapsed > this.config.pollIntervalSeconds * 1000) {
            log.warn(`It took us longer to update the feeds than the configured pool interval (${elapsed / 1000}s)`);
            sleepFor = 0;
        } else {
            sleepFor = this.config.pollIntervalSeconds * 1000 - elapsed;
            log.debug(`Feed fetching took ${elapsed / 1000}s, sleeping for ${sleepFor / 1000}s`);
        }

        setTimeout(() => {
            void this.pollFeeds();
        }, sleepFor);
    }
}
