import {Appservice, StateEvent} from "matrix-bot-sdk";
import { IConnection, IConnectionState, InstantiateConnectionOpts } from ".";
import { ApiError, ErrCode } from "../api";
import { BridgeConfigFeeds } from "../Config/Config";
import { FeedEntry, FeedError} from "../feeds/FeedReader";
import { Logger } from "matrix-appservice-bridge";
import { IBridgeStorageProvider } from "../Stores/StorageProvider";
import { BaseConnection } from "./BaseConnection";
import axios from "axios";
import markdown from "markdown-it";
import { Connection, ProvisionConnectionOpts } from "./IConnection";
import { GetConnectionsResponseItem } from "../provisioning/api";
import { StatusCodes } from "http-status-codes"; 
import { NodeHtmlMarkdown, NodeHtmlMarkdownOptions } from 'node-html-markdown';
const log = new Logger("FeedConnection");
const md = new markdown();

export interface LastResultOk {
    timestamp: number;
    ok: true;
}
export interface LastResultFail {
    timestamp: number;
    ok: false;
    error?: string;
}


export interface FeedConnectionState extends IConnectionState {
    url:    string;
    label?: string;
}

export interface FeedConnectionSecrets {
    lastResults: Array<LastResultOk|LastResultFail>;
}

export type FeedResponseItem = GetConnectionsResponseItem<FeedConnectionState, FeedConnectionSecrets>;

const MAX_LAST_RESULT_ITEMS = 5;

const nhm = new NodeHtmlMarkdown(
  /* options (optional) */ {},
  /* customTransformers (optional) */ undefined,
  /* customCodeBlockTranslators (optional) */ undefined
);

@Connection
export class FeedConnection extends BaseConnection implements IConnection {
    static readonly CanonicalEventType = "uk.half-shot.matrix-hookshot.feed";
    static readonly EventTypes = [ FeedConnection.CanonicalEventType ];
    static readonly ServiceCategory = "feed";

    public static createConnectionForState(roomId: string, event: StateEvent<any>, {config, as, storage}: InstantiateConnectionOpts) {
        if (!config.feeds?.enabled) {
            throw Error('RSS/Atom feeds are not configured');
        }
        return new FeedConnection(roomId, event.stateKey, event.content, config.feeds, as, storage);
    }

    static async validateUrl(url: string): Promise<void> {
        try {
            new URL(url);
        } catch (ex) {
            throw new ApiError("Feed URL doesn't appear valid", ErrCode.BadValue);
        }
        let res;
        try {
            res = await axios.head(url).catch(() => axios.get(url));
        } catch (ex) {
            throw new ApiError(`Could not read from URL: ${ex.message}`, ErrCode.BadValue);
        }
        const contentType = res.headers['content-type'];
        // we're deliberately liberal here, since different things pop up in the wild
        if (!contentType.match(/xml/)) {
            throw new ApiError(
                `Feed responded with a content type of "${contentType}", which doesn't look like an RSS/Atom feed`,
                ErrCode.BadValue,
                StatusCodes.UNSUPPORTED_MEDIA_TYPE
            );
        }
    }

    static async provisionConnection(roomId: string, _userId: string, data: Record<string, unknown> = {}, {as, config, storage}: ProvisionConnectionOpts) {
        if (!config.feeds?.enabled) {
            throw new ApiError('RSS/Atom feeds are not configured', ErrCode.DisabledFeature);
        }

        const url = data.url;
        if (typeof url !== 'string') {
            throw new ApiError('No URL specified', ErrCode.BadValue);
        }
        await FeedConnection.validateUrl(url);
        if (typeof data.label !== 'undefined' && typeof data.label !== 'string') {
            throw new ApiError('Label must be a string', ErrCode.BadValue);
        }

        const state = { url, label: data.label };

        const connection = new FeedConnection(roomId, url, state, config.feeds, as, storage);
        await as.botClient.sendStateEvent(roomId, FeedConnection.CanonicalEventType, url, state);

        return {
            connection,
            stateEventContent: state,
        }
    }

    public static getProvisionerDetails(botUserId: string) {
        return {
            service: "feeds",
            eventType: FeedConnection.CanonicalEventType,
            type: "Feed",
            // TODO: Add ability to configure the bot per connnection type.
            botUserId: botUserId,
        }
    }

    public getProvisionerDetails(): FeedResponseItem {
        return {
            ...FeedConnection.getProvisionerDetails(this.as.botUserId),
            id: this.connectionId,
            config: {
                url: this.feedUrl,
                label: this.state.label,
            },
            secrets: {
                lastResults: this.lastResults,
            }
        }
    }

    private hasError = false;
    private readonly lastResults = new Array<LastResultOk|LastResultFail>();

    public get feedUrl(): string {
        return this.state.url;
    }

    constructor(
        roomId: string,
        stateKey: string,
        private state: FeedConnectionState,
        private readonly config: BridgeConfigFeeds,
        private readonly as: Appservice,
        private readonly storage: IBridgeStorageProvider
    ) {
        super(roomId, stateKey, FeedConnection.CanonicalEventType)
        log.info(`Connection ${this.connectionId} created for ${roomId}, ${JSON.stringify(state)}`);
    }

    public isInterestedInStateEvent(eventType: string, stateKey: string): boolean {
        return !!FeedConnection.EventTypes.find(e => e === eventType) && stateKey === this.feedUrl;
    }

    public async handleFeedEntry(entry: FeedEntry): Promise<void> {

        let entryDetails;
        if (entry.title && entry.link) {
            entryDetails = `[${entry.title}](${entry.link})`;
        } else {
            entryDetails = entry.title || entry.link;
        }

        let message = `New post in ${this.state.label || entry.feed.title || entry.feed.url}`;
        if (entryDetails) {
            message += `: ${entryDetails}`;
        }

        // SC: overwrite format if enough infos
        if (entry.title && entry.link && (this.state.label || entry.feed.title)) {
            message = `[${this.state.label || entry.feed.title}](${entry.link}): ${entry.title}`;
            if (entry.content) {
                let content = nhm.translate(entry.content);
                // Try to make relative links absolute
                try {
                    const parsedUrl = new URL(entry.link);
                    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}`;
                    content = content.replace(/\[(.*?)\]\(\/(.*?)\)/g, '[$1](' + baseUrl + '/$2)');
                } catch (ex) {
                    log.info("Error trying to add absolute url to content " + ex.stack);
                }
                content = content
                        // Replace pictures by their alt text
                        .replace(/!\[(.*?)\]\(.*?\)/g, '$1')
                        // Remove code environments
                        .replace(/\`/g, '');
                message += `\n\n${content}`;
            }
        }

        await this.as.botIntent.sendEvent(this.roomId, {
            msgtype: 'm.text',
            format: "org.matrix.custom.html",
            formatted_body: md.render(message),
            body: message,
        });
    }

    handleFeedSuccess() {
        this.hasError = false;
        this.lastResults.unshift({
            ok: true,
            timestamp: Date.now(),
        });
        this.lastResults.splice(MAX_LAST_RESULT_ITEMS-1, 1);
    }

    public async handleFeedError(error: FeedError): Promise<void> {
        this.lastResults.unshift({
            ok: false,
            timestamp: Date.now(),
            error: error.message,
        });
        this.lastResults.splice(MAX_LAST_RESULT_ITEMS-1, 1);
        const wasLastResultSuccessful = this.lastResults[0]?.ok !== false;
        if (wasLastResultSuccessful && error.shouldErrorBeSilent) {
            // To avoid short term failures bubbling up, if the error is serious, we still bubble.
            return;
        }
        if (!this.hasError) {
            await this.as.botIntent.sendEvent(this.roomId, {
                msgtype: 'm.notice',
                format: 'm.text',
                body: `Error fetching ${this.feedUrl}: ${error.cause.message}`
            });
            this.hasError = true;
        }
    }

    // needed to ensure that the connection is removable
    public async onRemove(): Promise<void> {
        log.info(`Removing connection ${this.connectionId}`);
        await this.as.botClient.sendStateEvent(this.roomId, FeedConnection.CanonicalEventType, this.feedUrl, {});
    }

    toString(): string {
        return `FeedConnection ${this.state.url}`;
    }
}
